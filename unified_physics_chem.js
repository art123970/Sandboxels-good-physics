/*
 * Unified Physics & Chemistry v6.1 (unified_physics_chem.js)
 * Companion add-on for Sandboxels + chem.js
 * - Cloud-In-Cell (CIC) 2x2..8x8 Gravity & Magnetic Tiles (zero self-force) + Per-Pixel Velocity
 * - 8-neighbor velocity-driven compression (solids: stress/pressure, zero static heat;
 *   liquids: Pascal lateral flow; gases: adiabatic P dV heating + stellar pause/re-compression)
 * - Full stellar & reactor fusion (D-T -> p-p -> He -> C -> Ne/Mg -> O -> Si -> Ni56 -> Co56 -> Fe -> Supernova)
 * - Crash-proof neutron fission + Alpha/Beta/Gamma radiation + External-Map Bond Graph (Undo/Save safe)
 * - Supernova recursive tick1/tick2 cycle breaker + Dark-Mode Settings Panel ("Physics Settings" / Shift+P)
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. LIVE CONFIGURATION & PERSISTENCE
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "upc_v6_settings";
  const DEFAULT_CONFIG = {
    gravityMethod: "element",     // "element" | "star" | "com" | "wells_only" | "off"
    fieldTileSize: 4,             // 2 | 4 | 6 | 8
    fieldRebuildInterval: 2,      // 1..6 ticks
    gravAccel: 0.032,
    compressionHeatScale: 1.0,
    radiativeCooling: true,
    magScale: 1.0,
    maxSpeed: 2.6,
    starDrag: 0.996,
    fusionRate: 1.0,
    fissionHeatScale: 1.0,
    maxNeutrons: 320,
    maxBonds: 700,
    autoBonding: true,
    showBonds: true,
    showFields: false,
    plasmaConfinement: true,
    supernovaEnabled: true,
    curieDemagnetize: true,
    delayedNeutrons: true
  };

  const UPC_CONFIG = Object.assign({}, DEFAULT_CONFIG);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) {
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (saved[k] !== undefined && saved[k] !== null) UPC_CONFIG[k] = saved[k];
      }
    }
  } catch (e) {}

  function saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(UPC_CONFIG)); } catch (e) {}
  }

  let FIELD_BLOCK = 4, FIELD_REBUILD_INTERVAL = 2, MAX_SPEED = 2.6, GRAV_ACCEL = 0.032;
  let MAG_POLE_ACCEL = 0.18, MAG_FERRO_ACCEL = 0.55, MAG_MEISSNER_ACCEL = 0.72;
  let MAG_DIAMAG_ACCEL = 0.14, MAG_PLASMA_ACCEL = 0.45;
  let MAX_NEUTRONS = 320, MAX_BONDS = 700, activeFieldBlock = 0;
  const MAX_GAS_COMP = 8.0;

  const UPC_STATS = {
    lastTickMs: 0, activeGravTiles: 0, activeMagTiles: 0,
    movingPixels: 0, activeNeutrons: 0, activeBonds: 0
  };

  function applyUPCConfig(persist = true) {
    const nb = Math.max(2, Math.min(8, parseInt(UPC_CONFIG.fieldTileSize, 10) || 4));
    if (nb !== FIELD_BLOCK) { FIELD_BLOCK = nb; kernelX = null; }
    FIELD_REBUILD_INTERVAL = Math.max(1, Math.min(6, parseInt(UPC_CONFIG.fieldRebuildInterval, 10) || 2));
    const ga = Number(UPC_CONFIG.gravAccel);
    GRAV_ACCEL = Number.isNaN(ga) ? DEFAULT_CONFIG.gravAccel : Math.max(0, Math.min(0.25, ga));
    const cs = Number(UPC_CONFIG.compressionHeatScale);
    UPC_CONFIG.compressionHeatScale = Number.isNaN(cs) ? 1.0 : Math.max(0, Math.min(2.5, cs));
    const ms = Number(UPC_CONFIG.magScale);
    const sms = Number.isNaN(ms) ? 1.0 : Math.max(0, Math.min(4.0, ms));
    MAG_POLE_ACCEL = 0.18 * sms;
    MAG_FERRO_ACCEL = 0.55 * sms;
    MAG_MEISSNER_ACCEL = 0.72 * sms;
    MAG_DIAMAG_ACCEL = 0.14 * sms;
    MAG_PLASMA_ACCEL = 0.45 * sms;
    MAX_SPEED = Math.max(0.5, Math.min(3.5, Number(UPC_CONFIG.maxSpeed) || 2.6));
    MAX_NEUTRONS = Math.max(40, Math.min(800, parseInt(UPC_CONFIG.maxNeutrons, 10) || 320));
    MAX_BONDS = Math.max(0, Math.min(2000, parseInt(UPC_CONFIG.maxBonds, 10) || 700));
    UPC_CONFIG.starDrag = Math.max(0.85, Math.min(1.0, Number(UPC_CONFIG.starDrag) || 0.996));
    const fr = Number(UPC_CONFIG.fusionRate);
    UPC_CONFIG.fusionRate = Number.isNaN(fr) ? 1.0 : Math.max(0, Math.min(3.0, fr));
    UPC_CONFIG.fissionHeatScale = Math.max(0.2, Math.min(3.0, Number(UPC_CONFIG.fissionHeatScale) || 1.0));
    lastFieldTick = -100;
    if (persist) saveConfig();
    if (typeof syncSettingsUI === "function") syncSettingsUI();
  }

  if (typeof window !== "undefined") {
    window.UPC_CONFIG = UPC_CONFIG;
    window.UPC_STATS = UPC_STATS;
    window.applyUPCConfig = applyUPCConfig;
  }

  // ---------------------------------------------------------------------------
  // 2. CORE UTILITIES & STATE-CHAIN BUILDERS
  // ---------------------------------------------------------------------------

  const NON_ZERO_DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const randomDir = () => NON_ZERO_DIRS[Math.floor(Math.random() * 8)];
  const inSafeBounds = (x, y) => !outOfBounds(x, y) && pixelMap[x] !== undefined;
  const notifyUser = (msg) => (typeof logMessage === "function" ? logMessage(msg) : console.log("[UPC]", msg));

  function safeChange(pixel, elemName) {
    if (!pixel || pixel.del || !elements[elemName]) return false;
    changePixel(pixel, elemName);
    return true;
  }

  function safeChangeAny(pixel, list) {
    if (!pixel || pixel.del) return false;
    for (let i = 0; i < list.length; i++) {
      if (elements[list[i]]) { changePixel(pixel, list[i]); return true; }
    }
    return false;
  }

  function safeCreate(elemName, x, y) {
    if (!elements[elemName] || !inSafeBounds(x, y) || !isEmpty(x, y)) return null;
    createPixel(elemName, x, y);
    return pixelMap[x][y] || null;
  }

  function safeSwap(p1, p2) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del) return false;
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    if (!inSafeBounds(x1, y1) || !inSafeBounds(x2, y2)) return false;
    p1.x = x2; p1.y = y2; p2.x = x1; p2.y = y1;
    pixelMap[x1][y1] = p2; pixelMap[x2][y2] = p1;
    return true;
  }

  function findAdjacentElement(pixel, target) {
    const start = Math.floor(Math.random() * 8);
    const isSet = target instanceof Set;
    for (let i = 0; i < 8; i++) {
      const d = NON_ZERO_DIRS[(start + i) & 7];
      const nx = pixel.x + d[0], ny = pixel.y + d[1];
      if (!inSafeBounds(nx, ny)) continue;
      const o = pixelMap[nx][ny];
      if (o && !o.del && (isSet ? target.has(o.element) : o.element === target)) return o;
    }
    return null;
  }

  function getFusionFactor(pixel) {
    if (UPC_CONFIG.fusionRate <= 0) return 0;
    const comp = pixel.comp || 1.0;
    return UPC_CONFIG.fusionRate * Math.min(2.6, 0.75 + Math.max(0, comp - 1.0) * 0.55);
  }

  function safeAddReaction(elemName, targetName, reactionObj) {
    if (!elements[elemName]) return;
    if (!elements[elemName].reactions) elements[elemName].reactions = {};
    elements[elemName].reactions[targetName] = reactionObj;
  }

  function wrapTick(elemName, extraFn) {
    const el = elements[elemName];
    if (!el || el.tool) return;
    if (typeof el.tick1 === "function" && !String(el.tick1).includes("tick1")) {
      const orig1 = el.tick1;
      el.tick1 = function (pixel) {
        if (!pixel || pixel.del) return;
        if (extraFn(pixel) === true) return;
        if (!pixel.del) orig1(pixel);
      };
      return;
    }
    const prev = typeof el.tick === "function" ? el.tick : null;
    el.tick = function (pixel) {
      if (!pixel || pixel.del) return;
      if (extraFn(pixel) === true) return;
      if (pixel.del) return;
      if (prev) prev(pixel); else doDefaults(pixel);
    };
  }

  function registerOrEnhance(name, def) {
    const clean = {};
    for (const k of Object.keys(def)) {
      if (k === "_override") continue;
      if (k === "tick" && typeof def[k] !== "function") continue;
      if (def[k] === undefined || def[k] === null) continue;
      clean[k] = def[k];
    }
    if (!clean.tool && !clean.reactions) clean.reactions = {};
    if (elements[name]) {
      const ex = elements[name];
      if (clean.reactions) ex.reactions = Object.assign({}, ex.reactions || {}, clean.reactions);
      for (const k of Object.keys(clean)) {
        if (k !== "reactions" && (ex[k] === undefined || def._override)) ex[k] = clean[k];
      }
    } else {
      elements[name] = clean;
    }
  }

  function defineFullElement(cfg) {
    const {
      id, color, moltenColor, gasColor, category = "solids", meltTemp, boilTemp, density,
      conduct = 0.5, hardness = 0.7, behavior = behaviors.WALL, reactions = {}, tick, tickAllStates = false, desc = ""
    } = cfg;
    const moltenId = "molten_" + id, gasId = id + "_gas", hasTick = typeof tick === "function";

    const sDef = { color, behavior, category, state: "solid", density, conduct, hardness, tempHigh: meltTemp, stateHigh: moltenId, reactions: Object.assign({}, reactions), desc };
    if (hasTick) sDef.tick = tick;
    registerOrEnhance(id, sDef);

    const mDef = {
      color: moltenColor || ["#ff7b29", "#ff9e3d", "#ffb84d"], behavior: behaviors.LIQUID, category: "states", state: "liquid",
      hidden: true, density: Math.round(density * 0.9), conduct: conduct * 0.8, temp: meltTemp + 50,
      tempLow: meltTemp, stateLow: id, tempHigh: boilTemp, stateHigh: gasId, viscosity: 14, reactions: Object.assign({}, reactions)
    };
    if (hasTick) mDef.tick = tick;
    registerOrEnhance(moltenId, mDef);

    const gDef = {
      color: gasColor || ["#d9d9d9", "#bfbfbf"], behavior: behaviors.GAS, category: "states", state: "gas",
      hidden: true, density: Math.max(0.5, +(density / 1000).toFixed(2)), temp: boilTemp + 50,
      tempLow: boilTemp, stateLow: moltenId, reactions: Object.assign({}, reactions)
    };
    if (hasTick && tickAllStates) gDef.tick = tick;
    registerOrEnhance(gasId, gDef);
  }

  function defineFullGas(cfg) {
    const { id, color, liquidColor, solidColor, category = "gases", boilTemp, meltTemp, density, reactions = {}, tick, desc = "", conduct } = cfg;
    const liquidId = "liquid_" + id, solidId = "solid_" + id, hasTick = typeof tick === "function";

    const gDef = { color, behavior: behaviors.GAS, category, state: "gas", density, tempLow: boilTemp, stateLow: liquidId, reactions: Object.assign({}, reactions), desc };
    if (conduct !== undefined) gDef.conduct = conduct;
    if (hasTick) gDef.tick = tick;
    registerOrEnhance(id, gDef);

    const lDef = {
      color: liquidColor || color, behavior: behaviors.LIQUID, category: "states", state: "liquid", hidden: true,
      density: Math.max(50, Math.round(density * 600)), temp: boilTemp - 5, tempHigh: boilTemp, stateHigh: id,
      tempLow: meltTemp, stateLow: solidId, reactions: Object.assign({}, reactions)
    };
    if (hasTick) lDef.tick = tick;
    registerOrEnhance(liquidId, lDef);

    const sDef = {
      color: solidColor || liquidColor || color, behavior: behaviors.WALL, category: "states", state: "solid", hidden: true,
      density: Math.max(80, Math.round(density * 750)), temp: meltTemp - 5, tempHigh: meltTemp, stateHigh: liquidId, reactions: Object.assign({}, reactions)
    };
    if (hasTick) sDef.tick = tick;
    registerOrEnhance(solidId, sDef);
  }

  // ---------------------------------------------------------------------------
  // 3. EXTERNAL-GRAPH CHEMICAL BONDING ENGINE (100% JSON / UNDO / SAVE SAFE)
  // ---------------------------------------------------------------------------

  const bondGraph = new Map();
  let totalBondEdges = 0;

  const RADIOLYSIS_AGENTS = new Set(["radiation", "fast_neutron", "alpha_particle", "beta_particle", "gamma_ray"]);
  const AUTO_BOND_RULES = {
    "hydrogen|hydrogen":   { type: "covalent", breakTemp: 3500, minTemp: -250, maxTemp: 2500, prob: 0.08, maxA: 1, maxB: 1 },
    "hydrogen|oxygen":     { type: "polar",    breakTemp: 2800, minTemp: 120,  maxTemp: 2200, prob: 0.14, maxA: 1, maxB: 2 },
    "deuterium|oxygen":    { type: "polar",    breakTemp: 2850, minTemp: 120,  maxTemp: 2200, prob: 0.14, maxA: 1, maxB: 2 },
    "chlorine|sodium":     { type: "ionic",    breakTemp: 1450, minTemp: -50,  maxTemp: 1100, prob: 0.22, maxA: 1, maxB: 1 },
    "chlorine|hydrogen":   { type: "polar",    breakTemp: 2200, minTemp: -100, maxTemp: 1600, prob: 0.14, maxA: 1, maxB: 1 },
    "nitrogen|nitrogen":   { type: "covalent", breakTemp: 5500, minTemp: -200, maxTemp: 4000, prob: 0.06, maxA: 1, maxB: 1 },
    "hydrogen|nitrogen":   { type: "polar",    breakTemp: 1300, minTemp: 350,  maxTemp: 900,  prob: 0.08, maxA: 1, maxB: 3 },
    "carbon_vapor|oxygen": { type: "covalent", breakTemp: 3800, minTemp: 600,  maxTemp: 3200, prob: 0.12, maxA: 2, maxB: 2 },
    "graphite|graphite":   { type: "covalent", breakTemp: 4200, minTemp: 800,  maxTemp: 3400, prob: 0.04, maxA: 3, maxB: 3 },
    "silicon|silicon":     { type: "covalent", breakTemp: 2600, minTemp: 200,  maxTemp: 2200, prob: 0.04, maxA: 4, maxB: 4 },
    "oxygen|silicon":      { type: "covalent", breakTemp: 3000, minTemp: 700,  maxTemp: 2400, prob: 0.10, maxA: 2, maxB: 4 },
    "magnesium|oxygen":    { type: "ionic",    breakTemp: 2800, minTemp: 400,  maxTemp: 2300, prob: 0.18, maxA: 2, maxB: 2 },
    "cesium|chlorine":     { type: "ionic",    breakTemp: 1300, minTemp: -50,  maxTemp: 900,  prob: 0.25, maxA: 1, maxB: 1 },
    "iron|oxygen":         { type: "ionic",    breakTemp: 2200, minTemp: 300,  maxTemp: 1600, prob: 0.06, maxA: 2, maxB: 2 },
    "aluminum|oxygen":     { type: "ionic",    breakTemp: 2900, minTemp: 500,  maxTemp: 2400, prob: 0.08, maxA: 3, maxB: 2 }
  };

  const getBonds = (p) => bondGraph.get(p) || null;
  const getBondCount = (p) => (bondGraph.get(p) ? bondGraph.get(p).length : 0);
  const hasBondBetween = (p1, p2) => {
    const arr = bondGraph.get(p1);
    return arr ? arr.some(b => b.target === p2) : false;
  };

  function createBond(p1, p2, type = "covalent", breakTemp = 2500) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del || totalBondEdges >= MAX_BONDS || hasBondBetween(p1, p2)) return false;
    let b1 = bondGraph.get(p1), b2 = bondGraph.get(p2);
    if ((b1 && b1.length >= 4) || (b2 && b2.length >= 4)) return false;
    if (!b1) { b1 = []; bondGraph.set(p1, b1); }
    if (!b2) { b2 = []; bondGraph.set(p2, b2); }
    b1.push({ target: p2, type, breakTemp });
    b2.push({ target: p1, type, breakTemp });
    totalBondEdges++;
    p1.temp += 18; p2.temp += 18;
    return true;
  }

  function breakBondBetween(p1, p2, endothermic = true) {
    let removed = false;
    for (const [a, b] of [[p1, p2], [p2, p1]]) {
      const arr = bondGraph.get(a);
      if (!arr) continue;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].target === b) { arr.splice(i, 1); removed = true; }
      }
      if (arr.length === 0) bondGraph.delete(a);
    }
    if (removed) {
      totalBondEdges = Math.max(0, totalBondEdges - 1);
      if (endothermic) {
        if (p1 && !p1.del) p1.temp = Math.max(-273, p1.temp - 25);
        if (p2 && !p2.del) p2.temp = Math.max(-273, p2.temp - 25);
      }
    }
  }

  function breakAllBonds(pixel) {
    const arr = bondGraph.get(pixel);
    if (!arr) return;
    for (const b of arr.slice()) breakBondBetween(pixel, b.target, false);
  }

  function clearAllBonds() { bondGraph.clear(); totalBondEdges = 0; }

  const IMMOBILE_SPECIAL = new Set(["gravity_well", "star_gravity", "neutronium", "black_hole_core", "field_visualizer"]);

  function isImmobileElement(elemName) {
    const el = elements[elemName];
    if (!el) return true;
    if (IMMOBILE_SPECIAL.has(elemName) || el.movable === false || el.behavior === behaviors.WALL) return true;
    if (typeof el.tick === "function" && el.tick.name === "WALL") return true;
    if (typeof el.tick2 === "function" && el.tick2.name === "WALL") return true;
    return false;
  }

  function stepToward(mover, targetX, targetY) {
    if (!mover || mover.del || isImmobileElement(mover.element)) return false;
    const dx = Math.sign(targetX - mover.x), dy = Math.sign(targetY - mover.y);
    if (!dx && !dy) return false;
    const tries = [[mover.x + dx, mover.y + dy], [mover.x + dx, mover.y], [mover.x, mover.y + dy]];
    for (let i = 0; i < 3; i++) {
      const nx = tries[i][0], ny = tries[i][1];
      if (!inSafeBounds(nx, ny)) continue;
      if (isEmpty(nx, ny)) { movePixel(mover, nx, ny); return true; }
      const occ = pixelMap[nx][ny];
      if (occ && !occ.del && !isImmobileElement(occ.element)) {
        const st = elements[occ.element]?.state;
        if (st === "gas" || st === "liquid") return safeSwap(mover, occ);
      }
    }
    return false;
  }

  function updateBondsTick() {
    if (bondGraph.size > 0) {
      for (const p of Array.from(bondGraph.keys())) {
        const pBonds = bondGraph.get(p);
        if (!p || p.del || !pBonds || !pBonds.length || !inSafeBounds(p.x, p.y) || pixelMap[p.x][p.y] !== p) {
          breakAllBonds(p); bondGraph.delete(p); continue;
        }
        let hitBreaker = false, hitRad = false, hitWater = false;
        for (let c = 0; c < 8; c++) {
          const ax = p.x + NON_ZERO_DIRS[c][0], ay = p.y + NON_ZERO_DIRS[c][1];
          if (!inSafeBounds(ax, ay)) continue;
          const adj = pixelMap[ax][ay];
          if (!adj || adj.del) continue;
          if (adj.element === "bond_breaker") hitBreaker = true;
          else if (RADIOLYSIS_AGENTS.has(adj.element)) hitRad = true;
          else if (adj.element === "water") hitWater = true;
        }
        if (hitBreaker) { breakAllBonds(p); continue; }

        for (let j = pBonds.length - 1; j >= 0; j--) {
          const bond = pBonds[j], t = bond.target;
          if (!t || t.del || !inSafeBounds(t.x, t.y) || pixelMap[t.x][t.y] !== t) { breakBondBetween(p, t, false); continue; }
          const dist = Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y));
          if (dist > 3 || p.temp > bond.breakTemp || t.temp > bond.breakTemp) { breakBondBetween(p, t, true); continue; }
          if (((p.charge > 0) || (t.charge > 0)) && (bond.type === "ionic" || bond.type === "polar" || Math.random() < 0.4)) { breakBondBetween(p, t, true); continue; }
          if (hitRad && Math.random() < 0.35) { breakBondBetween(p, t, true); continue; }
          if (bond.type === "ionic" && hitWater && Math.random() < 0.18) { breakBondBetween(p, t, true); continue; }

          const avgT = (p.temp + t.temp) * 0.5;
          p.temp += (avgT - p.temp) * 0.25; t.temp += (avgT - t.temp) * 0.25;
          if (!isImmobileElement(p.element) && !isImmobileElement(t.element)) {
            const avx = ((p.vx || 0) + (t.vx || 0)) * 0.5, avy = ((p.vy || 0) + (t.vy || 0)) * 0.5;
            if (avx || avy) {
              p.vx = (p.vx || 0) + (avx - (p.vx || 0)) * 0.4; p.vy = (p.vy || 0) + (avy - (p.vy || 0)) * 0.4;
              t.vx = (t.vx || 0) + (avx - (t.vx || 0)) * 0.4; t.vy = (t.vy || 0) + (avy - (t.vy || 0)) * 0.4;
            }
          }
          if (dist > 1) {
            const pD = elements[p.element]?.density || 1000, tD = elements[t.element]?.density || 1000;
            if (!isImmobileElement(p.element) && (isImmobileElement(t.element) || pD <= tD)) stepToward(p, t.x, t.y);
            else stepToward(t, p.x, p.y);
          }
        }
      }
    }

    if (UPC_CONFIG.autoBonding && totalBondEdges < MAX_BONDS && currentPixels?.length) {
      const samples = Math.min(85, currentPixels.length);
      for (let s = 0; s < samples && totalBondEdges < MAX_BONDS; s++) {
        const p = currentPixels[Math.floor(Math.random() * currentPixels.length)];
        if (!p || p.del || getBondCount(p) >= 3) continue;
        const d = randomDir(), nx = p.x + d[0], ny = p.y + d[1];
        if (!inSafeBounds(nx, ny)) continue;
        const q = pixelMap[nx][ny];
        if (!q || q.del || getBondCount(q) >= 3) continue;
        const key = p.element < q.element ? p.element + "|" + q.element : q.element + "|" + p.element;
        const rule = AUTO_BOND_RULES[key];
        if (!rule) continue;
        const avgT = (p.temp + q.temp) * 0.5;
        if (avgT < rule.minTemp || avgT > rule.maxTemp) continue;
        const firstA = p.element <= q.element;
        if (getBondCount(p) >= (firstA ? rule.maxA : rule.maxB) || getBondCount(q) >= (firstA ? rule.maxB : rule.maxA)) continue;
        if (Math.random() < rule.prob) createBond(p, q, rule.type, rule.breakTemp);
      }
    }
    UPC_STATS.activeBonds = totalBondEdges;
  }

  function drawActiveBonds() {
    if (!UPC_CONFIG.showBonds || bondGraph.size === 0 || typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;
    ctx.save();
    ctx.lineWidth = Math.max(1, pixelSize * 0.26);
    ctx.lineCap = "round";
    bondGraph.forEach((bonds, p) => {
      if (!p || p.del) return;
      for (let i = 0; i < bonds.length; i++) {
        const t = bonds[i].target;
        if (!t || t.del || p.x > t.x || (p.x === t.x && p.y >= t.y)) continue;
        const ty = bonds[i].type;
        ctx.strokeStyle = ty === "ionic" ? "rgba(255,215,90,0.88)" : ty === "polar" ? "rgba(110,225,255,0.88)" : ty === "catalyst" ? "rgba(140,255,130,0.92)" : "rgba(255,255,255,0.82)";
        ctx.beginPath();
        ctx.moveTo((p.x + 0.5) * pixelSize, (p.y + 0.5) * pixelSize);
        ctx.lineTo((t.x + 0.5) * pixelSize, (t.y + 0.5) * pixelSize);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 4. CIC GRAVITY & MAGNETIC TILES + 8-NEIGHBOR VELOCITY-DRIVEN COMPRESSION
  // ---------------------------------------------------------------------------

  const IRON_FAMILY = new Set(["iron", "molten_iron", "iron_gas"]);
  const SUPER_R_TARGETS = new Set(["iron", "molten_iron", "iron_gas", "nickel", "molten_nickel", "nickel_gas", "cobalt", "molten_cobalt"]);
  const R_PRODUCTS = ["gold", "platinum", "lead", "thorium_232", "uranium_238", "uranium_235", "plutonium_239"];
  const STELLAR_GRAV_MASS = {
    hydrogen: 0.50, deuterium: 0.58, tritium: 0.64, helium_3: 0.66, helium: 0.74,
    carbon_vapor: 0.96, oxygen: 1.12, neon: 1.18, magnesium_gas: 1.28, silicon_gas: 1.48,
    nickel_56_gas: 2.05, cobalt_56_gas: 2.05, iron_gas: 2.15
  };
  const FERRO_CURIE = {
    iron: 770, molten_iron: 770, iron_filings: 770, steel: 750, cobalt: 1115, cobalt_60: 1115,
    nickel: 358, neodymium: 310, gadolinium: 20, rust: 580, metal_scrap: 750
  };
  const MAGNET_POLE_MAP = {
    magnet_north: 1, magnet_south: -1, neodymium_north: 1, neodymium_south: -1,
    electromagnet_north: 1, electromagnet_south: -1, magnet_bead_n: 1, magnet_bead_s: -1
  };
  const MAGNET_STRENGTH = {
    magnet_north: 1.0, magnet_south: -1.0, neodymium_north: 2.2, neodymium_south: -2.2,
    electromagnet_north: 1.9, electromagnet_south: -1.9, magnet_bead_n: 0.45, magnet_bead_s: -0.45
  };
  const PLASMA_CONFINABLE = new Set(["plasma", "hydrogen", "deuterium", "tritium", "helium", "helium_3", "carbon_vapor", "oxygen", "neon", "silicon_gas"]);
  const VELOCITY_EXEMPT = new Set(["fast_neutron", "thermal_neutron", "radiation", "alpha_particle", "beta_particle", "gamma_ray", "bond_breaker", "bond_catalyst"]);

  const FIELD_SOFT_PX2 = 13.6;
  const SELF_PHI_UNIT = 4 / Math.sqrt(FIELD_SOFT_PX2);

  let fieldMw = 0, fieldMh = 0, fieldKw = 0;
  let kernelX = null, kernelY = null, kernelPhi = null;
  let macroMass = null, macroGx = null, macroGy = null, macroPhi = null, macroIron = null, macroHotIron = null;
  let macroPole = null, macroMagAbs = null, macroBx = null, macroBy = null, macroMagPot = null, macroBmag = null, macroGradBx = null, macroGradBy = null;

  let lastFieldTick = -100, lastSupernovaTick = -200;
  let gravFieldActive = false, magFieldActive = false, starModeActive = false, visualizerActive = false, movingPixelsLastTick = 0;

  function getPixelGravMass(elemName, comp = 1.0) {
    const base = STELLAR_GRAV_MASS[elemName] !== undefined
      ? STELLAR_GRAV_MASS[elemName]
      : Math.min(4.2, Math.max(0.5, Math.pow((elements[elemName]?.density || 100) / 250, 0.45)));
    return base * (comp > 1.05 ? Math.min(1.55, 1 + (comp - 1) * 0.14) : 1.0);
  }

  function isFerromagneticNow(pixel) {
    const c = FERRO_CURIE[pixel.element];
    return c !== undefined && (!UPC_CONFIG.curieDemagnetize || pixel.temp <= c);
  }

  function ensureFieldTables() {
    if (typeof width !== "number" || typeof height !== "number") return false;
    const mw = Math.max(3, Math.ceil((width + 1) / FIELD_BLOCK) + 1);
    const mh = Math.max(3, Math.ceil((height + 1) / FIELD_BLOCK) + 1);
    if (mw === fieldMw && mh === fieldMh && FIELD_BLOCK === activeFieldBlock && kernelX) return true;

    activeFieldBlock = FIELD_BLOCK;
    fieldMw = mw; fieldMh = mh;
    const kw = 2 * mw - 1, kh = 2 * mh - 1;
    fieldKw = kw;
    kernelX = new Float32Array(kw * kh);
    kernelY = new Float32Array(kw * kh);
    kernelPhi = new Float32Array(kw * kh);

    for (let dy = -(mh - 1); dy <= mh - 1; dy++) {
      const rowOff = (dy + mh - 1) * kw, dyPx = dy * FIELD_BLOCK;
      for (let dx = -(mw - 1); dx <= mw - 1; dx++) {
        const idx = rowOff + (dx + mw - 1), dxPx = dx * FIELD_BLOCK;
        const invR = 1 / Math.sqrt(dxPx * dxPx + dyPx * dyPx + FIELD_SOFT_PX2);
        const invR3 = invR * invR * invR;
        kernelX[idx] = -16 * dxPx * invR3;
        kernelY[idx] = -16 * dyPx * invR3;
        kernelPhi[idx] = 4 * invR;
      }
    }

    const total = mw * mh;
    macroMass = new Float32Array(total); macroGx = new Float32Array(total); macroGy = new Float32Array(total);
    macroPhi = new Float32Array(total); macroIron = new Uint16Array(total); macroHotIron = new Uint16Array(total);
    macroPole = new Float32Array(total); macroMagAbs = new Float32Array(total);
    macroBx = new Float32Array(total); macroBy = new Float32Array(total); macroMagPot = new Float32Array(total);
    macroBmag = new Float32Array(total); macroGradBx = new Float32Array(total); macroGradBy = new Float32Array(total);
    return true;
  }

  function depositCIC(arr, x, y, val) {
    const fx = x / FIELD_BLOCK, fy = y / FIELD_BLOCK;
    const x0 = Math.max(0, Math.min(fieldMw - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(fieldMh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const ix = 1 - tx, iy = 1 - ty, r0 = y0 * fieldMw + x0, r1 = r0 + fieldMw;
    arr[r0] += val * ix * iy; arr[r0 + 1] += val * tx * iy;
    arr[r1] += val * ix * ty; arr[r1 + 1] += val * tx * ty;
  }

  function sampleField(arr, x, y) {
    if (!arr || fieldMw < 2 || fieldMh < 2) return 0;
    const fx = x / FIELD_BLOCK, fy = y / FIELD_BLOCK;
    const x0 = Math.max(0, Math.min(fieldMw - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(fieldMh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const r0 = y0 * fieldMw + x0, r1 = r0 + fieldMw;
    const top = arr[r0] + (arr[r0 + 1] - arr[r0]) * tx;
    const bot = arr[r1] + (arr[r1 + 1] - arr[r1]) * tx;
    return top + (bot - top) * ty;
  }

  function applyStateAwareCompression(p, gx, gy, phiNet) {
    const el = elements[p.element];
    const st = el?.state || "solid";
    const gMag = Math.hypot(gx, gy);

    // Count all 8 neighbors via NON_ZERO_DIRS (Sandboxels's adjacentCoords only has 4!)
    let surrounded = 0, emptyDx = 0, emptyDy = 0, emptyCount = 0;
    for (let c = 0; c < 8; c++) {
      const dx = NON_ZERO_DIRS[c][0], dy = NON_ZERO_DIRS[c][1];
      const cx = p.x + dx, cy = p.y + dy;
      if (!inSafeBounds(cx, cy) || !isEmpty(cx, cy)) {
        surrounded++;
      } else {
        emptyDx += dx; emptyDy += dy; emptyCount++;
      }
    }

    const imp = p.inwardImpulse || 0;
    p.inwardImpulse = imp * 0.45;

    const densNorm = Math.min(3.2, Math.max(0.25, Math.sqrt((el?.density || 1000) / 1000)));
    const pressureBase = phiNet > 4
      ? Math.round((phiNet * (0.65 + Math.min(2.2, gMag * 0.08)) * (surrounded / 8) * densNorm + imp * 30) * 1.35)
      : Math.round(imp * 20);
    p.pressure = pressureBase;

    const heatScale = UPC_CONFIG.compressionHeatScale;

    if (st === "solid") {
      // SOLIDS: Zero static gravitational heating; blocked inward velocity builds elastic stress
      const targetStress = Math.min(pressureBase * 0.8 + imp * 55, 1200);
      p.stress = Math.max(0, (p.stress || 0) * 0.88 + targetStress * 0.12);
      p.comp = +(1.0 + Math.min(0.05, p.stress / 8000)).toFixed(3);
      if (p.element === "graphite" && p.pressure > 220 && p.temp >= 1200 && elements.diamond) { safeChange(p, "diamond"); return; }
      if (p.element === "ice" && p.pressure > 320 && elements.water) { safeChange(p, "water"); return; }
      if (p.pressure > 620 && (el?.hardness ?? 0.7) < 0.55 && p.element === "stone" && elements.sand && Math.random() < 0.04) { safeChange(p, "sand"); return; }
      if (p.stress > 95 && emptyCount >= 3 && !isImmobileElement(p.element)) {
        const len = Math.hypot(emptyDx, emptyDy) || 1, kick = Math.min(0.95, p.stress / 320);
        p.vx = (p.vx || 0) + (emptyDx / len) * kick;
        p.vy = (p.vy || 0) + (emptyDy / len) * kick;
        p.stress *= 0.35;
      }
      return;
    }

    if (st === "liquid") {
      // LIQUIDS: Zero temperature explosion; Pascal's Law lateral flow perpendicular to gravity
      p.comp = +(1.0 + Math.min(0.08, pressureBase / 5000)).toFixed(3);
      p.stress = Math.round(pressureBase * 0.4);
      if (imp > 0.12 && emptyCount > 0 && gMag > 0.08) {
        const tx = -gy / gMag, ty = gx / gMag;
        const sign = (tx * emptyDx + ty * emptyDy) >= 0 ? 1 : -1;
        const flow = Math.min(0.85, imp * 0.55);
        p.vx = (p.vx || 0) + tx * sign * flow;
        p.vy = (p.vy || 0) + ty * sign * flow;
      }
      return;
    }

    // GASES & PLASMA: True adiabatic compression (p.comp = 1.0..8.0) + stellar pause/re-compression
    const oldComp = p.comp || 1.0;

    if (UPC_CONFIG.radiativeCooling && starModeActive && p.temp > 2500) {
      const coolFactor = surrounded < 6 ? 0.0085 : 0.0022;
      p.temp = Math.max(20, p.temp - (p.temp - 2500) * coolFactor);
    }

    const tempK = Math.max(200, p.temp + 273);
    const pTherm = Math.pow(tempK, 0.74) * 0.036 * Math.sqrt(oldComp);
    const pGrav = surrounded >= 5
      ? Math.max(0, phiNet - 15) * (2.2 + Math.min(2.4, imp * 1.2) + Math.min(1.2, gMag * 0.05))
      : 0;

    let newComp = oldComp;
    if (pGrav > pTherm && surrounded >= 5) {
      const drive = Math.min(1.6, (pGrav - pTherm) / Math.max(30, pGrav));
      const dComp = (0.03 + Math.min(0.16, imp * 0.10)) * drive * (surrounded / 8);
      newComp = Math.min(MAX_GAS_COMP, oldComp + dComp);
      if (heatScale > 0 && dComp > 0.0005) {
        const workHeat = (tempK * 0.65 * (dComp / oldComp) + dComp * 16500 + imp * 180) * heatScale;
        p.temp = Math.min(200000, p.temp + workHeat);
      }
    } else if (oldComp > 1.0) {
      const relaxRate = surrounded < 5 ? 0.14 : 0.045;
      const dComp = Math.min(oldComp - 1.0, (oldComp - 1.0) * relaxRate + 0.01);
      newComp = Math.max(1.0, oldComp - dComp);
      if (heatScale > 0 && dComp > 0.001 && p.temp > 20) {
        p.temp = Math.max(20, p.temp - tempK * 0.30 * (dComp / oldComp));
      }
      if (emptyCount > 0 && dComp > 0.01) {
        const len = Math.hypot(emptyDx, emptyDy) || 1, push = Math.min(1.1, dComp * 3.5);
        p.vx = (p.vx || 0) + (emptyDx / len) * push;
        p.vy = (p.vy || 0) + (emptyDy / len) * push;
      }
    }

    p.comp = +newComp.toFixed(3);
    p.stress = Math.round(Math.max(0, pGrav - pTherm));
  }

  function triggerSupernova(cx, cy, formBlackHole = false) {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t - lastSupernovaTick < 60) return;
    lastSupernovaTick = t;
    const coreElem = formBlackHole ? "black_hole_core" : "neutronium";

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx * dx + dy * dy > 5) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (p && !p.del) { safeChange(p, coreElem); p.temp = 130000; }
        else if (isEmpty(nx, ny)) { const np = safeCreate(coreElem, nx, ny); if (np) np.temp = 130000; }
      }
    }

    const shockR = 17;
    for (let dx = -shockR; dx <= shockR; dx++) {
      for (let dy = -shockR; dy <= shockR; dy++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= 6 || d2 > shockR * shockR) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (!p || p.del || IMMOBILE_SPECIAL.has(p.element)) continue;
        const dist = Math.sqrt(d2);
        p.temp += Math.round(48000 / dist);
        if (SUPER_R_TARGETS.has(p.element) && Math.random() < 0.45) {
          safeChange(p, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]);
        }
        if (!isImmobileElement(p.element)) {
          const kick = Math.min(MAX_SPEED, 15 / dist);
          p.vx = (p.vx || 0) + (dx / dist) * kick;
          p.vy = (p.vy || 0) + (dy / dist) * kick;
          p.comp = 1.0;
          movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
        }
      }
    }
    spawnNeutronsAround(cx, cy, 24, "fast_neutron");
    spawnParticle(cx, cy, "gamma_ray", 6);
    explodeAt(cx, cy, 11, "plasma,radiation,fire");
  }

  function rebuildFields() {
    if (!ensureFieldTables()) return;
    macroMass.fill(0); macroGx.fill(0); macroGy.fill(0); macroPhi.fill(0); macroIron.fill(0); macroHotIron.fill(0);
    macroPole.fill(0); macroMagAbs.fill(0); macroBx.fill(0); macroBy.fill(0); macroMagPot.fill(0);

    let hasStarGravity = false, hasPointWell = false, hasMagnets = false, hasVisualizer = false;
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del) continue;
      const e = p.element;
      if (e === "star_gravity") { hasStarGravity = true; continue; }
      if (e === "field_visualizer") { hasVisualizer = true; continue; }

      const ms = MAGNET_STRENGTH[e];
      if (ms !== undefined && ((e !== "electromagnet_north" && e !== "electromagnet_south") || p.charge > 0)) {
        depositCIC(macroPole, p.x, p.y, ms);
        depositCIC(macroMagAbs, p.x, p.y, Math.abs(ms));
        hasMagnets = true;
      }

      if (e === "gravity_well") { hasPointWell = true; depositCIC(macroMass, p.x, p.y, 48); }
      else if (e === "neutronium") { hasPointWell = true; depositCIC(macroMass, p.x, p.y, 105); }
      else if (e === "black_hole_core") { hasPointWell = true; depositCIC(macroMass, p.x, p.y, 210); }
      else if (!isImmobileElement(e)) {
        depositCIC(macroMass, p.x, p.y, getPixelGravMass(e, p.comp || 1.0));
        if (IRON_FAMILY.has(e)) {
          const bIdx = Math.min(fieldMh - 1, Math.max(0, Math.round(p.y / FIELD_BLOCK))) * fieldMw + Math.min(fieldMw - 1, Math.max(0, Math.round(p.x / FIELD_BLOCK)));
          macroIron[bIdx]++;
          if (p.temp > 85000) macroHotIron[bIdx]++;
        }
      }
    }

    const mode = UPC_CONFIG.gravityMethod;
    if (mode === "off") { hasStarGravity = false; hasPointWell = false; macroMass.fill(0); }
    else if (mode === "star") hasStarGravity = true;
    else if (mode === "wells_only") hasStarGravity = false;
    else if (mode === "com") {
      let totalM = 0, sumX = 0, sumY = 0;
      for (let by = 0; by < fieldMh; by++) {
        for (let bx = 0; bx < fieldMw; bx++) {
          const m = macroMass[by * fieldMw + bx];
          if (m > 0) { totalM += m; sumX += bx * m; sumY += by * m; }
        }
      }
      macroMass.fill(0);
      if (totalM > 0) {
        macroMass[Math.min(fieldMh - 1, Math.max(0, Math.round(sumY / totalM))) * fieldMw + Math.min(fieldMw - 1, Math.max(0, Math.round(sumX / totalM)))] = totalM;
        hasStarGravity = true;
      }
    }

    starModeActive = hasStarGravity;
    gravFieldActive = (hasStarGravity || hasPointWell) && GRAV_ACCEL > 0;
    magFieldActive = hasMagnets && MAG_POLE_ACCEL > 0;
    visualizerActive = hasVisualizer || !!UPC_CONFIG.showFields;

    if (mode !== "off" && mode !== "com" && !hasStarGravity && hasPointWell) {
      macroMass.fill(0);
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del) continue;
        const e = p.element;
        if (e === "gravity_well" || e === "neutronium" || e === "black_hole_core") {
          depositCIC(macroMass, p.x, p.y, e === "black_hole_core" ? 210 : e === "neutronium" ? 105 : 48);
        }
      }
    }

    UPC_STATS.activeGravTiles = 0; UPC_STATS.activeMagTiles = 0;
    if (!gravFieldActive && !magFieldActive) return;

    const mw = fieldMw, mh = fieldMh, kw = fieldKw;
    for (let sy = 0; sy < mh; sy++) {
      const sRow = sy * mw;
      for (let sx = 0; sx < mw; sx++) {
        const sIdx = sRow + sx;
        const m = gravFieldActive ? macroMass[sIdx] : 0;
        const q = magFieldActive ? macroPole[sIdx] : 0;
        const qAbs = magFieldActive ? macroMagAbs[sIdx] : 0;
        if (m > 0.001) UPC_STATS.activeGravTiles++;
        if (qAbs > 0.001) UPC_STATS.activeMagTiles++;
        if (m <= 0.001 && Math.abs(q) <= 0.001 && qAbs <= 0.001) continue;

        const kxBase = mw - 1 - sx;
        for (let ty = 0; ty < mh; ty++) {
          let gIdx = ty * mw, kIdx = (ty - sy + mh - 1) * kw + kxBase;
          if (m > 0.001 && qAbs > 0.001) {
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              const kx = kernelX[kIdx], ky = kernelY[kIdx], kp = kernelPhi[kIdx];
              macroGx[gIdx] += m * kx; macroGy[gIdx] += m * ky; macroPhi[gIdx] += m * kp;
              macroBx[gIdx] -= q * kx; macroBy[gIdx] -= q * ky; macroMagPot[gIdx] += qAbs * kp;
            }
          } else if (m > 0.001) {
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              macroGx[gIdx] += m * kernelX[kIdx]; macroGy[gIdx] += m * kernelY[kIdx]; macroPhi[gIdx] += m * kernelPhi[kIdx];
            }
          } else {
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              macroBx[gIdx] -= q * kernelX[kIdx]; macroBy[gIdx] -= q * kernelY[kIdx]; macroMagPot[gIdx] += qAbs * kernelPhi[kIdx];
            }
          }
        }
      }
    }

    if (magFieldActive) {
      const total = mw * mh, gScale = 2 / FIELD_BLOCK;
      for (let i = 0; i < total; i++) macroBmag[i] = Math.hypot(macroBx[i], macroBy[i]) + 0.25 * macroMagPot[i];
      for (let by = 0; by < mh; by++) {
        const row = by * mw, yP = by > 0 ? (by - 1) * mw : row, yN = by < mh - 1 ? (by + 1) * mw : row;
        for (let bx = 0; bx < mw; bx++) {
          const xP = bx > 0 ? bx - 1 : bx, xN = bx < mw - 1 ? bx + 1 : bx;
          macroGradBx[row + bx] = (macroBmag[row + xN] - macroBmag[row + xP]) * gScale;
          macroGradBy[row + bx] = (macroBmag[yN + bx] - macroBmag[yP + bx]) * gScale;
        }
      }
    }

    if (gravFieldActive && UPC_CONFIG.supernovaEnabled) {
      for (let by = 1; by < mh - 1; by++) {
        for (let bx = 1; bx < mw - 1; bx++) {
          const idx = by * mw + bx;
          if (macroIron[idx] < 6) continue;
          let ironSum = 0, hotSum = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const ni = (by + dy) * mw + (bx + dx);
            ironSum += macroIron[ni]; hotSum += macroHotIron[ni];
          }
          if (ironSum >= 18 && hotSum >= 10 && macroPhi[idx] > 45) {
            triggerSupernova(bx * FIELD_BLOCK, by * FIELD_BLOCK, hotSum >= 36 || macroPhi[idx] > 180);
            return;
          }
        }
      }
    }
  }

  function advancePixelByVelocity(p) {
    let remX = Math.trunc(p.rx), remY = Math.trunc(p.ry);
    if (!remX && !remY) return;
    p.rx -= remX; p.ry -= remY;
    const steps = Math.min(3, Math.max(Math.abs(remX), Math.abs(remY)));
    const pEl = elements[p.element], pDens = pEl?.density || 1000, pState = pEl?.state || "solid";

    for (let s = 0; s < steps; s++) {
      if (p.del) return;
      const sx = Math.sign(remX), sy = Math.sign(remY);
      if (!sx && !sy) break;
      const nx = p.x + sx, ny = p.y + sy;
      if (!inSafeBounds(nx, ny)) {
        if (sx) p.vx = 0; if (sy) p.vy = 0; p.rx = 0; p.ry = 0; p.freeSteps = 0; break;
      }
      if (isEmpty(nx, ny)) {
        movePixel(p, nx, ny); p.freeSteps = Math.min(20, (p.freeSteps || 0) + 1); remX -= sx; remY -= sy; continue;
      }
      if (sx && sy) {
        if (inSafeBounds(p.x + sx, p.y) && isEmpty(p.x + sx, p.y)) { movePixel(p, p.x + sx, p.y); p.freeSteps = Math.min(20, (p.freeSteps || 0) + 1); remX -= sx; p.vy *= 0.5; continue; }
        if (inSafeBounds(p.x, p.y + sy) && isEmpty(p.x, p.y + sy)) { movePixel(p, p.x, p.y + sy); p.freeSteps = Math.min(20, (p.freeSteps || 0) + 1); remY -= sy; p.vx *= 0.5; continue; }
      }
      const target = pixelMap[nx][ny];
      if (!target || target.del) break;
      const blockedSpd = Math.hypot(p.vx || 0, p.vy || 0);

      if (!isImmobileElement(target.element)) {
        const tInfo = elements[target.element], tDens = tInfo?.density || 1000, tState = tInfo?.state || "solid";
        if ((tState === "gas" || tState === "liquid") && pDens > tDens * 1.15) {
          safeSwap(p, target); p.vx *= 0.88; p.vy *= 0.88; p.freeSteps = 0; remX -= sx; remY -= sy; continue;
        }
        const tvx = target.vx || 0, tvy = target.vy || 0, relSpd = Math.hypot(p.vx - tvx, p.vy - tvy);
        const impAdd = Math.min(1.5, relSpd * 0.65);
        p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + impAdd);
        target.inwardImpulse = Math.min(4.0, (target.inwardImpulse || 0) + impAdd * 0.85);
        if ((p.freeSteps || 0) >= 2 && relSpd > 1.55) {
          const heat = Math.min(180, Math.round((relSpd - 1.45) * 28));
          p.temp += heat; target.temp += heat;
        }
        p.freeSteps = 0; target.freeSteps = 0;
        if (pState === "solid" && tState === "solid" && relSpd < 0.9) {
          if (sx) { p.vx = 0; p.rx = 0; } if (sy) { p.vy = 0; p.ry = 0; }
        } else {
          const tot = pDens + tDens, nvx = (pDens * p.vx + tDens * tvx) / tot, nvy = (pDens * p.vy + tDens * tvy) / tot;
          const damp = (pState === "solid" && tState === "solid") ? 0.55 : 0.82;
          p.vx = nvx * damp; p.vy = nvy * damp;
          target.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, tvx + (nvx - tvx) * 1.05));
          target.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, tvy + (nvy - tvy) * 1.05));
        }
        break;
      } else {
        p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + blockedSpd * 0.6);
        if ((p.freeSteps || 0) >= 2 && blockedSpd > 1.65) p.temp += Math.min(120, Math.round((blockedSpd - 1.55) * 22));
        p.freeSteps = 0;
        if (sx) { p.vx = Math.abs(p.vx) > 1.2 ? -p.vx * 0.25 : 0; p.rx = 0; }
        if (sy) { p.vy = Math.abs(p.vy) > 1.2 ? -p.vy * 0.25 : 0; p.ry = 0; }
        p.vx *= 0.85; p.vy *= 0.85; break;
      }
    }
  }

  function updateGravityAndCompressionTick() {
    if (!currentPixels?.length) return;
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t - lastFieldTick >= FIELD_REBUILD_INTERVAL) { lastFieldTick = t; rebuildFields(); }
    if (!gravFieldActive && !magFieldActive && movingPixelsLastTick === 0) { UPC_STATS.movingPixels = 0; return; }

    const doComp = gravFieldActive && ((t & 1) === 0);
    let movingNow = 0;

    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del || isImmobileElement(p.element) || VELOCITY_EXEMPT.has(p.element)) continue;

      let ax = 0, ay = 0, gx = 0, gy = 0;
      if (gravFieldActive) {
        gx = sampleField(macroGx, p.x, p.y);
        gy = sampleField(macroGy, p.x, p.y);
        const radP = p.temp > 38000 ? Math.min(0.78, ((p.temp - 38000) / 115000) * Math.min(1.5, 0.7 + (p.comp || 1) * 0.25)) : 0;
        const gScale = GRAV_ACCEL * (1 - radP);
        ax += gx * gScale; ay += gy * gScale;
      }

      if (magFieldActive) {
        const pole = MAGNET_POLE_MAP[p.element];
        if (pole !== undefined) {
          ax += pole * sampleField(macroBx, p.x, p.y) * MAG_POLE_ACCEL;
          ay += pole * sampleField(macroBy, p.x, p.y) * MAG_POLE_ACCEL;
        } else if (isFerromagneticNow(p)) {
          ax += sampleField(macroGradBx, p.x, p.y) * MAG_FERRO_ACCEL;
          ay += sampleField(macroGradBy, p.x, p.y) * MAG_FERRO_ACCEL;
        } else if (p.element === "superconductor" && p.temp <= -180) {
          ax -= sampleField(macroGradBx, p.x, p.y) * MAG_MEISSNER_ACCEL;
          ay -= sampleField(macroGradBy, p.x, p.y) * MAG_MEISSNER_ACCEL;
        } else if (p.element === "bismuth") {
          ax -= sampleField(macroGradBx, p.x, p.y) * MAG_DIAMAG_ACCEL;
          ay -= sampleField(macroGradBy, p.x, p.y) * MAG_DIAMAG_ACCEL;
        } else if (UPC_CONFIG.plasmaConfinement && p.temp >= 6000 && PLASMA_CONFINABLE.has(p.element)) {
          ax -= sampleField(macroGradBx, p.x, p.y) * MAG_PLASMA_ACCEL;
          ay -= sampleField(macroGradBy, p.x, p.y) * MAG_PLASMA_ACCEL;
        }
      }

      const pEl = elements[p.element];
      if ((pEl?.state || "solid") === "solid") {
        const pDens = pEl?.density || 1000;
        if (ax) {
          const sx = Math.sign(ax), nx = p.x + sx;
          const nb = inSafeBounds(nx, p.y) ? pixelMap[nx][p.y] : null;
          const nbStatic = !inSafeBounds(nx, p.y) || (nb && (isImmobileElement(nb.element) || ((elements[nb.element]?.state || "solid") === "solid" && (elements[nb.element]?.density || 1000) >= pDens * 0.85 && ((nb.vx || 0) * sx <= 0.15))));
          if (nbStatic) { p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + Math.abs(ax)); ax = 0; if (Math.sign(p.vx || 0) === sx) { p.vx = 0; p.rx = 0; } p.freeSteps = 0; }
        }
        if (ay) {
          const sy = Math.sign(ay), ny = p.y + sy;
          const nb = inSafeBounds(p.x, ny) ? pixelMap[p.x][ny] : null;
          const nbStatic = !inSafeBounds(p.x, ny) || (nb && (isImmobileElement(nb.element) || ((elements[nb.element]?.state || "solid") === "solid" && (elements[nb.element]?.density || 1000) >= pDens * 0.85 && ((nb.vy || 0) * sy <= 0.15))));
          if (nbStatic) { p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + Math.abs(ay)); ay = 0; if (Math.sign(p.vy || 0) === sy) { p.vy = 0; p.ry = 0; } p.freeSteps = 0; }
        }
      }

      if (doComp) {
        const selfM = starModeActive ? getPixelGravMass(p.element, p.comp || 1.0) : 0;
        const phiNet = Math.max(0, sampleField(macroPhi, p.x, p.y) - selfM * SELF_PHI_UNIT);
        applyStateAwareCompression(p, gx, gy, phiNet);
        if (p.del) continue;
      }

      const prevVx = p.vx || 0, prevVy = p.vy || 0;
      if (!ax && !ay && !prevVx && !prevVy) continue;
      const drag = starModeActive ? UPC_CONFIG.starDrag : 0.94;
      let vx = (prevVx + ax) * drag, vy = (prevVy + ay) * drag;
      const spd2 = vx * vx + vy * vy;
      if (spd2 > MAX_SPEED * MAX_SPEED) { const sc = MAX_SPEED / Math.sqrt(spd2); vx *= sc; vy *= sc; }
      if (Math.abs(vx) < 0.015) vx = 0;
      if (Math.abs(vy) < 0.015) vy = 0;
      p.vx = vx; p.vy = vy;
      if (vx || vy) {
        movingNow++;
        p.rx = (p.rx || 0) + vx; p.ry = (p.ry || 0) + vy;
        advancePixelByVelocity(p);
      }
    }
    movingPixelsLastTick = movingNow;
    UPC_STATS.movingPixels = movingNow;
  }

  function drawFieldOverlay() {
    if (!visualizerActive || (!gravFieldActive && !magFieldActive) || typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;
    ctx.save();
    ctx.lineWidth = Math.max(1, pixelSize * 0.22);
    const stepPx = FIELD_BLOCK * pixelSize;
    for (let by = 0; by < fieldMh - 1; by++) {
      for (let bx = 0; bx < fieldMw - 1; bx++) {
        const idx = by * fieldMw + bx, cx = bx * stepPx, cy = by * stepPx;
        if (magFieldActive) {
          const bLen = Math.hypot(macroBx[idx], macroBy[idx]);
          if (bLen > 0.15) {
            const dL = Math.min(stepPx * 0.45, Math.log1p(bLen) * stepPx * 0.22);
            ctx.strokeStyle = "rgba(0,235,255,0.55)";
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (macroBx[idx] / bLen) * dL, cy + (macroBy[idx] / bLen) * dL); ctx.stroke();
          }
        }
        if (gravFieldActive) {
          const gLen = Math.hypot(macroGx[idx], macroGy[idx]);
          if (gLen > 0.4) {
            const dL = Math.min(stepPx * 0.45, Math.log1p(gLen) * stepPx * 0.16);
            ctx.strokeStyle = "rgba(255,196,61,0.50)";
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (macroGx[idx] / gLen) * dL, cy + (macroGy[idx] / gLen) * dL); ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 5. NUCLEAR FISSION & IONIZING RADIATION ENGINE
  // ---------------------------------------------------------------------------

  const MODERATOR_PROB = { water: 0.55, ice: 0.50, heavy_water: 0.45, heavy_ice: 0.42, graphite: 0.35, paraffin: 0.52 };
  const REFLECTORS = new Set(["beryllium", "molten_beryllium", "tungsten", "steel"]);
  const POISONS = new Set(["boron", "molten_boron", "cadmium", "molten_cadmium", "hafnium", "molten_hafnium", "xenon_135"]);
  const HIGH_Z_SHIELD = new Set(["lead", "molten_lead", "tungsten", "osmium", "uranium_238", "concrete"]);
  const BETA_SHIELD = new Set(["aluminum", "iron", "steel", "copper", "glass", "lead", "tungsten", "osmium", "concrete", "titanium"]);
  const MAX_SPAWN_PER_TICK = 40, MAX_IONIZING = 220, EXPLODE_COOLDOWN_TICKS = 8;

  let lastPhysicsTick = -1, neutronsThisTick = 0, prevTickNeutrons = 0, spawnedThisTick = 0, ionizingThisTick = 0, lastExplodeTick = -100, loggedNeutronError = false;

  function syncPhysicsTick() {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t !== lastPhysicsTick) {
      prevTickNeutrons = neutronsThisTick; UPC_STATS.activeNeutrons = neutronsThisTick;
      neutronsThisTick = 0; spawnedThisTick = 0; ionizingThisTick = 0; lastPhysicsTick = t;
    }
  }

  const FISSILE_SPECS = {
    uranium_235:          { th: 0.78, fa: 0.08, n: [2, 3], heat: 2400, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    molten_uranium_235:   { th: 0.72, fa: 0.07, n: [2, 3], heat: 2400, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    plutonium_239:        { th: 0.82, fa: 0.24, n: [2, 3], heat: 2700, d: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    molten_plutonium_239: { th: 0.78, fa: 0.22, n: [2, 3], heat: 2700, d: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    uranium_233:          { th: 0.80, fa: 0.14, n: [2, 3], heat: 2300, d: ["barium_141", "krypton_92", "strontium_90"] },
    molten_uranium_233:   { th: 0.75, fa: 0.12, n: [2, 3], heat: 2300, d: ["barium_141", "krypton_92", "strontium_90"] },
    uranium:              { th: 0.35, fa: 0.03, n: [2, 2], heat: 1600, d: ["barium_141", "krypton_92", "xenon_135"] },
    plutonium:            { th: 0.82, fa: 0.24, n: [2, 3], heat: 2700, d: ["barium_141", "xenon_135", "strontium_90"] },
    enriched_uranium:     { th: 0.76, fa: 0.08, n: [2, 3], heat: 2400, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] }
  };

  function spawnParticle(cx, cy, elemName, count = 1) {
    syncPhysicsTick();
    if (!elements[elemName] || ionizingThisTick >= MAX_IONIZING) return;
    const dirs = NON_ZERO_DIRS.slice().sort(() => Math.random() - 0.5);
    let sp = 0;
    for (let i = 0; i < 8 && sp < count && ionizingThisTick < MAX_IONIZING; i++) {
      const np = safeCreate(elemName, cx + dirs[i][0], cy + dirs[i][1]);
      if (np) {
        np.vx = dirs[i][0]; np.vy = dirs[i][1];
        np.life = elemName === "alpha_particle" ? 18 : elemName === "beta_particle" ? 55 : 90;
        sp++; ionizingThisTick++;
      }
    }
  }

  function spawnNeutronsAround(cx, cy, count, type = "fast_neutron") {
    syncPhysicsTick();
    if (!elements[type] || prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS || spawnedThisTick >= MAX_SPAWN_PER_TICK) return;
    const dirs = NON_ZERO_DIRS.slice().sort(() => Math.random() - 0.5);
    let sp = 0;
    for (let i = 0; i < 8 && sp < count; i++) {
      if (prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS || spawnedThisTick >= MAX_SPAWN_PER_TICK) break;
      for (let dist = 1; dist <= 2; dist++) {
        const np = safeCreate(type, cx + dirs[i][0] * dist, cy + dirs[i][1] * dist);
        if (np) { np.vx = dirs[i][0]; np.vy = dirs[i][1]; np.life = 95; sp++; spawnedThisTick++; break; }
      }
    }
  }

  function triggerFission(targetPixel, spec, neutronPixel) {
    syncPhysicsTick();
    if (!targetPixel || targetPixel.del) return;
    const tx = targetPixel.x, ty = targetPixel.y;
    safeChange(targetPixel, spec.d[Math.floor(Math.random() * spec.d.length)]);
    const heatAmt = Math.round(spec.heat * UPC_CONFIG.fissionHeatScale);
    targetPixel.temp += heatAmt;
    let nearbyFissile = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const nx = tx + dx, ny = ty + dy;
      if (!inSafeBounds(nx, ny)) continue;
      const p = pixelMap[nx][ny];
      if (p && !p.del) { p.temp += Math.round(heatAmt * 0.18); if (FISSILE_SPECS[p.element]) nearbyFissile++; }
    }
    if (neutronPixel && !neutronPixel.del && inSafeBounds(neutronPixel.x, neutronPixel.y) && pixelMap[neutronPixel.x][neutronPixel.y] === neutronPixel) {
      deletePixel(neutronPixel.x, neutronPixel.y);
    }
    spawnNeutronsAround(tx, ty, spec.n[0] + (Math.random() < 0.5 ? spec.n[1] - spec.n[0] : 0), "fast_neutron");
    if (Math.random() < 0.3) spawnParticle(tx, ty, "gamma_ray", 1);
    if (targetPixel.temp > 6000 && nearbyFissile >= 10 && lastPhysicsTick - lastExplodeTick >= EXPLODE_COOLDOWN_TICKS) {
      lastExplodeTick = lastPhysicsTick;
      explodeAt(tx, ty, 8, "plasma,fire,radiation,fallout");
    }
  }

  function ionizingParticleTick(pixel, kind) {
    if (!pixel || pixel.del) return;
    syncPhysicsTick(); ionizingThisTick++;
    if (ionizingThisTick > MAX_IONIZING * 1.4) { deletePixel(pixel.x, pixel.y); return; }
    if (!pixel.vx && !pixel.vy) { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; }
    if (pixel.life === undefined) pixel.life = kind === "alpha" ? 18 : kind === "beta" ? 55 : 90;
    if (--pixel.life <= 0) {
      if (kind === "alpha" && Math.random() < 0.35 && elements.helium) safeChange(pixel, "helium");
      else deletePixel(pixel.x, pixel.y);
      return;
    }
    const steps = kind === "gamma" ? 3 : kind === "beta" ? 2 : 1;
    for (let s = 0; s < steps && !pixel.del; s++) {
      const nx = pixel.x + pixel.vx, ny = pixel.y + pixel.vy;
      if (!inSafeBounds(nx, ny)) { deletePixel(pixel.x, pixel.y); return; }
      if (isEmpty(nx, ny)) { movePixel(pixel, nx, ny); continue; }
      const target = pixelMap[nx][ny];
      if (!target || target === pixel || target.del) continue;
      const tElem = target.element;
      if (kind === "alpha") {
        if (tElem === "beryllium" || tElem === "molten_beryllium") { spawnNeutronsAround(target.x, target.y, 1, "fast_neutron"); target.temp += 80; deletePixel(pixel.x, pixel.y); return; }
        if (elements[tElem]?.state === "gas") { safeSwap(pixel, target); target.temp += 5; }
        else { target.temp += 45; if (Math.random() < 0.25 && elements.helium) safeChange(pixel, "helium"); else deletePixel(pixel.x, pixel.y); return; }
      } else if (kind === "beta") {
        if (BETA_SHIELD.has(tElem)) { target.temp += 22; deletePixel(pixel.x, pixel.y); return; }
        target.temp += 6; safeSwap(pixel, target);
      } else {
        if (HIGH_Z_SHIELD.has(tElem) && Math.random() < 0.55) { target.temp += 35; deletePixel(pixel.x, pixel.y); return; }
        target.temp += 10; safeSwap(pixel, target);
      }
    }
  }

  function neutronTick(pixel, isFast) {
    try {
      if (!pixel || pixel.del) return;
      syncPhysicsTick(); neutronsThisTick++;
      if (neutronsThisTick > MAX_NEUTRONS * 1.25) { deletePixel(pixel.x, pixel.y); return; }
      if (!pixel.vx && !pixel.vy) { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; }
      if (pixel.life === undefined) pixel.life = 95;
      if (--pixel.life <= 0) { safeChangeAny(pixel, ["proton", "hydrogen"]); return; }

      const steps = isFast ? 2 : 1;
      for (let s = 0; s < steps && !pixel.del; s++) {
        const nx = pixel.x + pixel.vx, ny = pixel.y + pixel.vy;
        if (!inSafeBounds(nx, ny)) { deletePixel(pixel.x, pixel.y); return; }
        if (isEmpty(nx, ny)) { movePixel(pixel, nx, ny); continue; }
        const target = pixelMap[nx][ny];
        if (!target || target === pixel || target.del) continue;
        const tElem = target.element;

        if (FISSILE_SPECS[tElem]) {
          const spec = FISSILE_SPECS[tElem];
          let prob = isFast ? spec.fa : spec.th;
          if (!isFast && target.temp > 1200) prob *= Math.max(0.65, 1 - (target.temp - 1200) / 10000);
          if (Math.random() < prob) { triggerFission(target, spec, pixel); return; }
          if (Math.random() < 0.5) safeSwap(pixel, target); else { pixel.vx = -pixel.vx; pixel.vy = -pixel.vy; }
          return;
        }
        if (isFast && target.temp > 75000 && SUPER_R_TARGETS.has(tElem) && Math.random() < 0.40) {
          safeChange(target, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]); deletePixel(pixel.x, pixel.y); return;
        }
        if ((tElem === "uranium_238" || tElem === "molten_uranium_238") && Math.random() < (isFast ? 0.12 : 0.35) + (target.temp > 800 ? 0.08 : 0)) {
          safeChange(target, "neptunium_239"); target.temp += 150; deletePixel(pixel.x, pixel.y); return;
        }
        if ((tElem === "thorium_232" || tElem === "molten_thorium_232" || tElem === "thorium") && Math.random() < (isFast ? 0.10 : 0.38)) {
          safeChange(target, "protactinium_233"); target.temp += 140; deletePixel(pixel.x, pixel.y); return;
        }
        if ((tElem === "lithium_6" || tElem === "molten_lithium_6") && Math.random() < 0.55) {
          safeChange(target, "tritium"); target.temp += 850; safeChange(pixel, "helium"); return;
        }
        if ((tElem === "cobalt" || tElem === "molten_cobalt") && Math.random() < 0.30) {
          safeChange(target, "cobalt_60"); target.temp += 120; deletePixel(pixel.x, pixel.y); return;
        }
        if (tElem === "nitrogen" && !isFast && Math.random() < 0.12) {
          safeChange(target, "carbon_14"); safeChangeAny(pixel, ["proton", "hydrogen"]); return;
        }
        if (POISONS.has(tElem) && !isFast && Math.random() < (tElem === "xenon_135" ? 0.96 : 0.85)) {
          target.temp += 80;
          if (tElem === "boron" && Math.random() < 0.15) safeChange(target, "lithium_7");
          else if (tElem === "xenon_135") safeChange(target, "xenon_136");
          deletePixel(pixel.x, pixel.y); return;
        }
        if (MODERATOR_PROB[tElem] !== undefined) {
          target.temp += isFast ? 35 : 5;
          if (isFast) {
            if (tElem === "water" && Math.random() < 0.05) { safeChange(target, "heavy_water"); deletePixel(pixel.x, pixel.y); return; }
            if (Math.random() < MODERATOR_PROB[tElem]) { safeChange(pixel, "thermal_neutron"); const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; return; }
          }
          safeSwap(pixel, target); return;
        }
        if (REFLECTORS.has(tElem)) {
          pixel.vx = Math.max(-1, Math.min(1, -pixel.vx + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0)));
          pixel.vy = Math.max(-1, Math.min(1, -pixel.vy + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0)));
          if (!pixel.vx && !pixel.vy) { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; }
          if (isFast && !pixel.beMultiplied && (tElem === "beryllium" || tElem === "molten_beryllium") && Math.random() < 0.08) {
            pixel.beMultiplied = true; spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
          }
          return;
        }
        if (HIGH_Z_SHIELD.has(tElem)) {
          target.temp += 15;
          if (Math.random() < 0.45) { deletePixel(pixel.x, pixel.y); return; }
          pixel.vx = -pixel.vx; pixel.vy = -pixel.vy; return;
        }
        const tState = elements[tElem]?.state;
        if (tState === "gas" || tElem === "fire" || tElem === "plasma" || RADIOLYSIS_AGENTS.has(tElem)) safeSwap(pixel, target);
        else { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; return; }
      }
    } catch (err) {
      if (!loggedNeutronError) { loggedNeutronError = true; console.error("[UPC] neutronTick error:", err); }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. INTERACTIVE PHYSICS TOOLS ("tools" CATEGORY)
  // ---------------------------------------------------------------------------

  registerOrEnhance("orbit_launch", {
    color: ["#ffcf40", "#ffe082"], category: "tools",
    desc: "Gives brushed matter exact circular orbital velocity perpendicular to local gravity.",
    tool: (p) => {
      if (!p || p.del || isImmobileElement(p.element) || VELOCITY_EXEMPT.has(p.element)) return;
      if (!gravFieldActive) rebuildFields();
      if (!gravFieldActive) return;
      const gx = sampleField(macroGx, p.x, p.y), gy = sampleField(macroGy, p.x, p.y), gMag = Math.hypot(gx, gy);
      if (gMag < 0.01) return;
      const selfM = starModeActive ? getPixelGravMass(p.element, p.comp || 1.0) : 0;
      const phiNet = Math.max(0, sampleField(macroPhi, p.x, p.y) - selfM * SELF_PHI_UNIT);
      const vCirc = Math.min(MAX_SPEED * 0.92, Math.sqrt(4 * phiNet * GRAV_ACCEL));
      p.vx = (-gy / gMag) * vCirc; p.vy = (gx / gMag) * vCirc;
      movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }
  });

  registerOrEnhance("kinetic_launch", {
    color: ["#ff6e40", "#ff9e80"], category: "tools",
    desc: "Launches brushed matter rapidly right & slightly upward.",
    tool: (p) => {
      if (!p || p.del || isImmobileElement(p.element) || VELOCITY_EXEMPT.has(p.element)) return;
      p.vx = MAX_SPEED * 0.88; p.vy = -0.35; movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }
  });

  registerOrEnhance("vel_stop", {
    color: ["#78909c", "#b0bec5"], category: "tools",
    desc: "Cancels all velocity on brushed pixels immediately.",
    tool: (p) => { if (p && !p.del) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; } }
  });

  registerOrEnhance("compress_tool", {
    color: ["#ab47bc", "#ce93d8"], category: "tools",
    desc: "Shock Compressor: compresses gases (raising comp & temp) or presses hot graphite into diamond / ice into water.",
    tool: (p) => {
      if (!p || p.del) return;
      p.pressure = (p.pressure || 0) + 400;
      const st = elements[p.element]?.state;
      if (st === "gas") { p.comp = Math.min(MAX_GAS_COMP, (p.comp || 1.0) + 0.65); p.temp += 1800; }
      else if (st === "liquid") p.temp += 40;
      else {
        p.stress = Math.min(1200, (p.stress || 0) + 250);
        if (p.element === "graphite" && p.temp >= 1200 && elements.diamond) safeChange(p, "diamond");
        else if (p.element === "ice" && elements.water) safeChange(p, "water");
      }
    }
  });

  registerOrEnhance("bond_tool", {
    color: ["#69f0ae", "#b9f6ca"], category: "tools",
    desc: "Links adjacent pixels with persistent chemical bonds (keeping both pixels intact).",
    tool: (p) => {
      if (!p || p.del || getBondCount(p) >= 3) return;
      for (let i = 0; i < 8; i++) {
        const nx = p.x + NON_ZERO_DIRS[i][0], ny = p.y + NON_ZERO_DIRS[i][1];
        if (!inSafeBounds(nx, ny)) continue;
        const o = pixelMap[nx][ny];
        if (o && !o.del && !hasBondBetween(p, o) && createBond(p, o, "catalyst", 2800)) return;
      }
    }
  });

  registerOrEnhance("cleave_tool", {
    color: ["#ff5252", "#ff8a80"], category: "tools",
    desc: "Snaps all chemical bonds on brushed pixels.",
    tool: (p) => { if (p && !p.del) breakAllBonds(p); }
  });

  registerOrEnhance("magnetize_tool", {
    color: ["#e53935", "#1e88e5"], category: "tools",
    desc: "Magnetizes iron/steel/neodymium or flips North <-> South poles.",
    tool: (p) => {
      if (!p || p.del) return;
      const map = { iron: "magnet_north", steel: "magnet_north", iron_filings: "magnet_bead_n", neodymium: "neodymium_north", magnet_north: "magnet_south", magnet_south: "magnet_north", neodymium_north: "neodymium_south", neodymium_south: "neodymium_north", magnet_bead_n: "magnet_bead_s", magnet_bead_s: "magnet_bead_n" };
      if (map[p.element]) safeChange(p, map[p.element]);
    }
  });

  registerOrEnhance("neutron_pulse", {
    color: ["#ff6d00", "#ffd180"], category: "tools",
    desc: "Emits fast neutrons around brushed pixels to jump-start fission or breeding.",
    tool: (p) => { if (p && !p.del && Math.random() < 0.35) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); }
  });

  let lastInspectTime = 0;
  registerOrEnhance("inspect_tool", {
    color: ["#26c6da", "#80deea"], category: "tools",
    desc: "Displays state, temp, compression (comp), pressure, stress, velocity, g, B, and active chemical bonds.",
    tool: (p) => {
      if (!p || p.del) return;
      const now = Date.now();
      if (now - lastInspectTime < 250) return;
      lastInspectTime = now;
      const st = elements[p.element]?.state || "?";
      const g = gravFieldActive ? Math.hypot(sampleField(macroGx, p.x, p.y), sampleField(macroGy, p.x, p.y)).toFixed(2) : "0";
      const b = magFieldActive ? sampleField(macroBmag, p.x, p.y).toFixed(2) : "0";
      const pb = getBonds(p);
      const bl = pb?.length ? pb.map(x => `${x.target.element}(${x.type})`).join(", ") : "none";
      notifyUser(`${p.element}[${st}] | ${Math.round(p.temp)}C | comp=${(p.comp || 1).toFixed(2)}x | P=${p.pressure || 0} | stress=${Math.round(p.stress || 0)} | v=(${(p.vx || 0).toFixed(2)},${(p.vy || 0).toFixed(2)}) | g=${g} | B=${b} | bonds: ${bl}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. ASTROPHYSICS, BONDING, MAGNETS, RADIATION & SPECIAL ELEMENTS
  // ---------------------------------------------------------------------------

  registerOrEnhance("star_gravity", { color: ["#1a0b2e", "#31135e", "#4d1f91"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 99999, hardness: 1, desc: "Enables global multi-body CIC Gravity-Tile self-gravity." });
  registerOrEnhance("gravity_well", { color: ["#120024", "#2a0052", "#5900a6"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 99999, hardness: 1, desc: "Localized planetary/stellar gravity anchor." });
  registerOrEnhance("field_visualizer", { color: ["#00e5ff", "#ffd740"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 1000, desc: "Renders live Magnetic (cyan) and Gravity (gold) field vectors." });
  registerOrEnhance("neutronium", {
    color: ["#d9f7ff", "#ffffff", "#9ce5ff"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 999999, hardness: 1, conduct: 1,
    desc: "Degenerate neutron-star core forged by Supernova collapse.",
    tick: (p) => { if (Math.random() < 0.004) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); }
  });
  registerOrEnhance("black_hole_core", {
    color: ["#050008", "#0d0014", "#1a0029"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 9999999, hardness: 1,
    desc: "Event-horizon singularity. Devours infalling matter and emits gamma jets.",
    tick: (p) => {
      for (let i = 0; i < 8; i++) {
        const nx = p.x + NON_ZERO_DIRS[i][0], ny = p.y + NON_ZERO_DIRS[i][1];
        if (!inSafeBounds(nx, ny)) continue;
        const v = pixelMap[nx][ny];
        if (!v || v.del || IMMOBILE_SPECIAL.has(v.element)) continue;
        breakAllBonds(v); deletePixel(nx, ny);
        if (Math.random() < 0.25) spawnParticle(p.x, p.y, "gamma_ray", 1);
      }
      doDefaults(p);
    }
  });

  registerOrEnhance("bond_catalyst", {
    color: ["#6bff7a", "#9cff9e", "#3de050"], behavior: behaviors.POWDER, category: "chemistry", state: "solid", density: 10,
    desc: "Drop onto two adjacent elements to link them with a persistent chemical bond.",
    tick: (p) => {
      const nb = [];
      for (let i = 0; i < 8; i++) {
        const nx = p.x + NON_ZERO_DIRS[i][0], ny = p.y + NON_ZERO_DIRS[i][1];
        if (inSafeBounds(nx, ny) && pixelMap[nx][ny] && !pixelMap[nx][ny].del && pixelMap[nx][ny].element !== "bond_catalyst" && pixelMap[nx][ny].element !== "bond_breaker") nb.push(pixelMap[nx][ny]);
      }
      for (let a = 0; a < nb.length; a++) for (let b = a + 1; b < nb.length; b++) {
        if (Math.max(Math.abs(nb[a].x - nb[b].x), Math.abs(nb[a].y - nb[b].y)) <= 2 && createBond(nb[a], nb[b], "catalyst", 2600)) { deletePixel(p.x, p.y); return; }
      }
      doDefaults(p);
    }
  });
  registerOrEnhance("bond_breaker", {
    color: ["#ff477e", "#ff7096", "#e0245e"], behavior: behaviors.GAS, category: "chemistry", state: "gas", density: 0.5,
    desc: "Cleaves all persistent chemical bonds on contact.",
    tick: (p) => { if (p.life === undefined) p.life = 25; if (--p.life <= 0) { deletePixel(p.x, p.y); return; } doDefaults(p); }
  });

  // Magnets
  registerOrEnhance("magnet_north", { color: ["#d92626", "#e83838", "#bf1d1d"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.5, hardness: 0.8, tempHigh: 770, stateHigh: "iron", desc: "North pole (Curie: 770 C)." });
  registerOrEnhance("magnet_south", { color: ["#1e5ad9", "#2e6df0", "#1749b5"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.5, hardness: 0.8, tempHigh: 770, stateHigh: "iron", desc: "South pole (Curie: 770 C)." });
  registerOrEnhance("neodymium_north", { color: ["#ff1744", "#ff4569", "#d5002f"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.45, hardness: 0.75, tempHigh: 310, stateHigh: "neodymium", desc: "Strong Neodymium North pole (Curie: 310 C)." });
  registerOrEnhance("neodymium_south", { color: ["#0044ff", "#2962ff", "#0032bd"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.45, hardness: 0.75, tempHigh: 310, stateHigh: "neodymium", desc: "Strong Neodymium South pole (Curie: 310 C)." });
  registerOrEnhance("electromagnet_north", { color: ["#b85d38", "#cc6b43", "#9e4d2d"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 8400, conduct: 1, hardness: 0.8, desc: "Switchable North Electromagnet (power with shock/battery)." });
  registerOrEnhance("electromagnet_south", { color: ["#486b9e", "#587eb5", "#3b5985"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 8400, conduct: 1, hardness: 0.8, desc: "Switchable South Electromagnet (power with shock/battery)." });
  registerOrEnhance("magnet_bead_n", { color: ["#ff5252", "#ff7575"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7400, hardness: 0.75, tempHigh: 770, stateHigh: "iron_filings", desc: "Movable North-pole magnetic bead." });
  registerOrEnhance("magnet_bead_s", { color: ["#448aff", "#69a1ff"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7400, hardness: 0.75, tempHigh: 770, stateHigh: "iron_filings", desc: "Movable South-pole magnetic bead." });
  registerOrEnhance("iron_filings", { color: ["#525559", "#64686e", "#43464a"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7870, conduct: 0.7, hardness: 0.72, tempHigh: 1538, stateHigh: "molten_iron", desc: "Ferromagnetic iron powder (Curie: 770 C)." });
  registerOrEnhance("superconductor", { color: ["#242933", "#303745", "#1c2029"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 6300, conduct: 1, hardness: 0.7, desc: "YBCO Superconductor. Chill below -180 C for Meissner levitation." });

  // Radiation, Neutrons, Heavy Water, Carbon Vapor & Graphite
  registerOrEnhance("fast_neutron", { color: ["#ff4444", "#ff7744", "#ffaa44"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, temp: 20, desc: "Fast ~2 MeV neutron.", tick: (p) => neutronTick(p, true) });
  registerOrEnhance("thermal_neutron", { color: ["#44ccff", "#66eeff", "#99f5ff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, temp: 20, desc: "Slow ~0.025 eV thermal neutron.", tick: (p) => neutronTick(p, false) });
  registerOrEnhance("alpha_particle", { color: ["#ffea00", "#ffff72"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Alpha particle (He-4 nucleus). Knocks neutrons from Beryllium.", tick: (p) => ionizingParticleTick(p, "alpha") });
  registerOrEnhance("beta_particle", { color: ["#00e5ff", "#84ffff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Beta electron. Stopped by Aluminum/Glass/metals.", tick: (p) => ionizingParticleTick(p, "beta") });
  registerOrEnhance("gamma_ray", { color: ["#ea80fc", "#ffffff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Gamma photon. Attenuated by Lead/Tungsten/Osmium/U-238/Concrete.", tick: (p) => ionizingParticleTick(p, "gamma") });
  registerOrEnhance("heavy_water", { color: ["#1e5ec4", "#246ad6", "#1a52ab"], behavior: behaviors.LIQUID, category: "nuclear", state: "liquid", density: 1107, tempHigh: 101.4, stateHigh: "heavy_steam", tempLow: 3.8, stateLow: "heavy_ice", conduct: 0.02, desc: "Deuterium Oxide (D2O) moderator." });
  registerOrEnhance("heavy_ice", { color: ["#a8d0f5", "#b8daf8"], behavior: behaviors.WALL, category: "states", state: "solid", hidden: true, density: 1017, temp: 0, tempHigh: 3.8, stateHigh: "heavy_water" });
  registerOrEnhance("heavy_steam", {
    color: ["#c7dbf0", "#d7e6f5"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 0.66, temp: 110, tempLow: 101.4, stateLow: "heavy_water",
    tick: (p) => { if (p.temp >= 3200 && Math.random() < 0.2) { safeChange(p, Math.random() < 0.66 ? "deuterium" : "oxygen"); return; } doDefaults(p); }
  });
  registerOrEnhance("carbon_vapor", {
    color: ["#54545c", "#666670", "#45454d"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 0.52, temp: 3700, tempLow: 3642, stateLow: "graphite",
    desc: "Elemental Carbon-12 gas (>3,642 C). Fuses with He (75,000 C -> O) or C (82,000 C -> Ne/Mg).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0) {
        if (p.temp >= 75000 && Math.random() < 0.18 * fr) { const he = findAdjacentElement(p, "helium"); if (he) { safeChange(p, "oxygen"); safeChange(he, "gamma_ray"); p.temp += 5000; return; } }
        if (p.temp >= 82000 && Math.random() < 0.15 * fr) { const o = findAdjacentElement(p, "carbon_vapor"); if (o) { safeChange(p, Math.random() < 0.55 ? "neon" : "magnesium_gas"); safeChange(o, "gamma_ray"); p.temp += 4500; return; } }
      }
      doDefaults(p);
    },
    reactions: { oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.25 } }
  });
  registerOrEnhance("graphite", {
    _override: true, color: ["#2b2b2e", "#36363a", "#232326"], behavior: behaviors.WALL, category: "nuclear", state: "solid", density: 2260, conduct: 0.85, hardness: 0.65, tempHigh: 3642, stateHigh: "carbon_vapor",
    desc: "Carbon moderator. Sublimates to carbon_vapor (>3,642 C); smelts sand -> silicon & rust -> iron; presses to diamond.",
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.15 },
      sand:   { elem1: "carbon_dioxide", elem2: "molten_silicon", tempMin: 1900, tempMax: 3500, chance: 0.22 },
      rust:   { elem1: "carbon_dioxide", elem2: "molten_iron", tempMin: 1100, tempMax: 3200, chance: 0.25 }
    }
  });

  // ---------------------------------------------------------------------------
  // 8. FULL GASES, ISOTOPES & SOLID/MOLTEN/GAS ELEMENT CHAINS
  // ---------------------------------------------------------------------------

  const SILICON_STATES = new Set(["silicon", "molten_silicon", "silicon_gas"]);

  defineFullGas({
    id: "deuterium", color: ["#6ea8ff", "#88bbff"], liquidColor: ["#3c7de0", "#4f8ef0"], solidColor: ["#a6cbff", "#c2dcff"],
    category: "isotopes", boilTemp: -249.5, meltTemp: -254.4, density: 0.18,
    desc: "Hydrogen-2. Fuses with T (10,000 C), D (25,000 C), or He-3 (40,000 C).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0) {
        if (p.temp >= 10000 && Math.random() < 0.55 * fr) { const t = findAdjacentElement(p, "tritium"); if (t) { safeChange(p, "helium"); safeChange(t, "fast_neutron"); p.temp += 9000; t.temp += 9000; return; } }
        if (p.temp >= 25000 && Math.random() < 0.35 * fr) { const o = findAdjacentElement(p, "deuterium"); if (o) { if (Math.random() < 0.5) { safeChange(p, "tritium"); safeChangeAny(o, ["proton", "hydrogen"]); } else { safeChange(p, "helium_3"); safeChange(o, "fast_neutron"); } p.temp += 4500; o.temp += 4500; return; } }
        if (p.temp >= 40000 && Math.random() < 0.45 * fr) { const h = findAdjacentElement(p, "helium_3"); if (h) { safeChange(p, "helium"); safeChangeAny(h, ["proton", "hydrogen"]); p.temp += 11000; h.temp += 11000; return; } }
      }
      doDefaults(p);
    },
    reactions: { oxygen: { elem1: "heavy_steam", elem2: "fire", tempMin: 560, tempMax: 3000, chance: 0.65 } }
  });

  defineFullGas({
    id: "tritium", color: ["#5cffb0", "#82ffc4"], liquidColor: ["#28d483", "#3ee093"], solidColor: ["#9effd0", "#c4ffe2"],
    category: "isotopes", boilTemp: -248.1, meltTemp: -252.5, density: 0.27, desc: "Hydrogen-3. Fuses with Deuterium (10,000 C); beta-decays to He-3.",
    tick: (p) => { if (Math.random() < 0.00015) { safeChange(p, "helium_3"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 5; return; } doDefaults(p); }
  });

  defineFullGas({
    id: "helium_3", color: ["#ffe0b3", "#ffd18c"], liquidColor: ["#f0b86e", "#e6a855"], solidColor: ["#fff0d9", "#ffe6bf"],
    category: "isotopes", boilTemp: -269.9, meltTemp: -272.2, density: 0.13, desc: "Helium-3. Aneutronic fusion with D (40,000 C) or He-3 (45,000 C).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0 && p.temp >= 45000 && Math.random() < 0.25 * fr) { const o = findAdjacentElement(p, "helium_3"); if (o) { safeChange(p, "helium"); safeChangeAny(o, ["proton", "hydrogen"]); p.temp += 7500; o.temp += 7500; return; } }
      doDefaults(p);
    }
  });

  defineFullGas({
    id: "neon", color: ["#ff9678", "#ffab91"], liquidColor: ["#ff7043", "#ff8a65"], solidColor: ["#ffccbc", "#ffd8cc"],
    category: "gases", boilTemp: -246.1, meltTemp: -248.6, density: 0.90, conduct: 0.4, desc: "Noble gas forged by Carbon burning. Fuses with He (88,000 C -> Mg).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0 && p.temp >= 88000 && Math.random() < 0.16 * fr) { const he = findAdjacentElement(p, "helium"); if (he) { safeChange(p, "magnesium_gas"); safeChange(he, "gamma_ray"); p.temp += 4200; return; } }
      doDefaults(p);
    }
  });

  defineFullGas({ id: "argon", color: ["#c7b8ff", "#d6ccff"], liquidColor: ["#9b87f5", "#ac99ff"], solidColor: ["#e6e0ff", "#f0ecff"], category: "gases", boilTemp: -185.8, meltTemp: -189.3, density: 1.78, desc: "Dense inert shielding gas." });
  defineFullGas({ id: "radon", color: ["#b8e0c8", "#ccebd8"], liquidColor: ["#8ac2a0", "#9cd4b2"], solidColor: ["#ffaa55", "#ff8844"], category: "isotopes", boilTemp: -61.7, meltTemp: -71.0, density: 9.73, desc: "Heavy radioactive noble gas; decays to Polonium-210.", tick: (p) => { if (Math.random() < 0.0005) { safeChange(p, "polonium_210"); spawnParticle(p.x, p.y, "alpha_particle", 1); p.temp += 20; return; } doDefaults(p); } });
  defineFullGas({ id: "xenon_135", color: ["#9a78e3", "#b091f2"], liquidColor: ["#6c47bd", "#7d55d1"], solidColor: ["#c6b3f5", "#d8c9fa"], category: "isotopes", boilTemp: -108.1, meltTemp: -111.8, density: 5.89, desc: "Reactor poison. Burns to Xe-136 or decays to Cs-135.", tick: (p) => { if (Math.random() < 0.0012) { safeChange(p, "cesium_135"); spawnParticle(p.x, p.y, "beta_particle", 1); return; } doDefaults(p); } });
  defineFullGas({ id: "xenon_136", color: ["#7c6fa8", "#9183bd"], liquidColor: ["#5a4d82", "#695a94"], solidColor: ["#b5abdb", "#c8c0e6"], category: "isotopes", boilTemp: -108.1, meltTemp: -111.8, density: 5.93, desc: "Stable Xenon-136." });
  defineFullGas({ id: "krypton_92", color: ["#b8d4e8", "#cfe5f5"], liquidColor: ["#80a8c7", "#92bad9"], solidColor: ["#dcebf7", "#ebf4fc"], category: "isotopes", boilTemp: -153.4, meltTemp: -157.4, density: 3.75, desc: "Fission gas emitting delayed neutrons -> Sr-90.", tick: (p) => { p.temp += 0.15; if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.0015) spawnNeutronsAround(p.x, p.y, 1, "thermal_neutron"); if (Math.random() < 0.004) { safeChange(p, "strontium_90"); return; } doDefaults(p); } });

  const FULL_ELEMENTS = [
    { id: "carbon_14", color: ["#303835", "#3d4743"], moltenColor: ["#7a8f87", "#8ea69d"], gasColor: ["#5c6b65", "#6d7d77"], category: "isotopes", meltTemp: 3550, boilTemp: 4027, density: 2260, conduct: 0.7, behavior: behaviors.POWDER, desc: "Radioactive C-14 -> N-14.", tick: (p) => { if (Math.random() < 0.0001) { safeChange(p, "nitrogen"); spawnParticle(p.x, p.y, "beta_particle", 1); return; } doDefaults(p); } },
    { id: "magnesium", color: ["#d4d9de", "#e2e6eb", "#c5cbd1"], moltenColor: ["#f0e8d5", "#fff8e8"], gasColor: ["#e8ecf0", "#f5f7fa"], category: "metals", meltTemp: 650, boilTemp: 1091, density: 1738, conduct: 0.78, hardness: 0.5, tickAllStates: true, desc: "Reactive metal; fuses with He (92,000 C -> Silicon).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 92000 && Math.random() < 0.16 * fr) { const he = findAdjacentElement(p, "helium"); if (he) { safeChange(p, "silicon_gas"); safeChange(he, "gamma_ray"); p.temp += 4000; return; } } doDefaults(p); }, reactions: { oxygen: { elem1: "ash", elem2: "fire", tempMin: 470, tempMax: 3200, chance: 0.45, func: p1 => { p1.temp += 1800; } }, steam: { elem1: "ash", elem2: "hydrogen", tempMin: 300, chance: 0.35, func: p1 => { p1.temp += 900; } } } },
    { id: "silicon", color: ["#4b525c", "#58606b", "#3f464f"], moltenColor: ["#e8a86b", "#f2b97e"], gasColor: ["#8a96a6", "#9ca8b8"], category: "solids", meltTemp: 1414, boilTemp: 3265, density: 2329, conduct: 0.35, hardness: 0.82, tickAllStates: true, desc: "Semiconductor (Si-28). Fuses past 115,000 C into Nickel-56 -> Iron.", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 115000 && Math.random() < 0.16 * fr) { const pt = findAdjacentElement(p, "helium") || findAdjacentElement(p, SILICON_STATES); if (pt) { safeChange(p, "nickel_56_gas"); safeChange(pt, "gamma_ray"); p.temp += 3000; return; } } doDefaults(p); }, reactions: { oxygen: { elem1: "sand", elem2: "fire", tempMin: 900, tempMax: 2500, chance: 0.15 } } },
    { id: "nickel_56", color: ["#9cb5a8", "#adc7b9"], moltenColor: ["#ffbe76", "#ffd39b"], gasColor: ["#c7e3d4", "#daf2e5"], category: "isotopes", meltTemp: 1455, boilTemp: 2913, density: 8908, conduct: 0.7, tickAllStates: true, desc: "Supernova Nickel-56 -> Cobalt-56 -> Iron-56.", tick: (p) => { p.temp += 0.35; if (Math.random() < 0.008) { safeChange(p, p.element === "nickel_56_gas" ? "cobalt_56_gas" : p.element === "molten_nickel_56" ? "molten_cobalt_56" : "cobalt_56"); p.temp += 180; return; } doDefaults(p); } },
    { id: "cobalt_56", color: ["#7295c4", "#86a8d6"], moltenColor: ["#ffa366", "#ffb885"], gasColor: ["#a4bfe3", "#b8cff0"], category: "isotopes", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.7, tickAllStates: true, desc: "Decays into stable Iron-56.", tick: (p) => { p.temp += 0.25; if (Math.random() < 0.006) { if (p.temp >= 2862) safeChangeAny(p, ["iron_gas", "molten_iron", "iron"]); else if (p.temp >= 1538) safeChangeAny(p, ["molten_iron", "iron"]); else safeChange(p, "iron"); p.temp += 120; return; } doDefaults(p); } },
    { id: "uranium_235", color: ["#4b7843", "#578c4e", "#3f6938"], moltenColor: ["#9be05a", "#b7f06e"], gasColor: ["#88b878", "#a2cc95"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 18950, conduct: 0.45, desc: "Fissile U-235.", tick: (p) => { if (Math.random() < 0.00025) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "uranium_238", color: ["#3b4d3b", "#455945", "#324232"], moltenColor: ["#7a9c59", "#8eb06a"], gasColor: ["#6b7d6b", "#7c8f7c"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 19100, conduct: 0.45, desc: "Fertile U-238; breeds Np-239 -> Pu-239." },
    { id: "neptunium_239", color: ["#5e6e7d", "#6e8091"], moltenColor: ["#b58d52", "#cfa363"], gasColor: ["#8e9eab", "#a3b3c2"], category: "isotopes", meltTemp: 644, boilTemp: 3902, density: 20450, conduct: 0.35, desc: "Breeder intermediate -> Pu-239.", tick: (p) => { p.temp += 0.08; if (Math.random() < 0.003) { safeChange(p, "plutonium_239"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 60; return; } doDefaults(p); } },
    { id: "plutonium_239", color: ["#6b756b", "#7d8a7d", "#5c665c"], moltenColor: ["#e68a45", "#f5a056"], gasColor: ["#9ca89c", "#b0bdb0"], category: "nuclear", meltTemp: 640, boilTemp: 3228, density: 19816, conduct: 0.25, desc: "Fissile Pu-239.", tick: (p) => { p.temp += 0.05; if (Math.random() < 0.0006) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "thorium_232", color: ["#63605c", "#75726d", "#575450"], moltenColor: ["#d98a4e", "#eb9e60"], gasColor: ["#8f8b85", "#a39f98"], category: "nuclear", meltTemp: 1750, boilTemp: 4788, density: 11724, conduct: 0.5, desc: "Fertile Th-232; breeds Pa-233 -> U-233." },
    { id: "protactinium_233", color: ["#7a7380", "#8c8494"], moltenColor: ["#c78b63", "#db9e74"], gasColor: ["#a199a8", "#b3abc0"], category: "isotopes", meltTemp: 1568, boilTemp: 4027, density: 15370, conduct: 0.4, desc: "Thorium breeder -> U-233.", tick: (p) => { p.temp += 0.06; if (Math.random() < 0.002) { safeChange(p, "uranium_233"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 50; return; } doDefaults(p); } },
    { id: "uranium_233", color: ["#4d8066", "#5a9476", "#427058"], moltenColor: ["#8be0a4", "#a3f0ba"], gasColor: ["#84b89c", "#9accb1"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 18900, conduct: 0.45, desc: "Fissile U-233." },
    { id: "californium_252", color: ["#a8b099", "#bcc4ab"], moltenColor: ["#ffad66", "#ffc285"], gasColor: ["#d4dbc5", "#e4ebd5"], category: "nuclear", meltTemp: 900, boilTemp: 1470, density: 15100, conduct: 0.4, desc: "Spontaneous-fission neutron source.", tick: (p) => { p.temp += 0.35; if (Math.random() < 0.03) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "americium_241", color: ["#c2c7cc", "#d3d8de"], moltenColor: ["#f0b07a", "#ffc48f"], gasColor: ["#dee3e8", "#eef2f7"], category: "isotopes", meltTemp: 1176, boilTemp: 2607, density: 13670, conduct: 0.45, desc: "Alpha emitter (pair with Beryllium).", tick: (p) => { p.temp += 0.12; if (Math.random() < 0.015) spawnParticle(p.x, p.y, "alpha_particle", 1); doDefaults(p); } },
    { id: "radium_226", color: ["#80ff95", "#a3ffb3", "#64e87b"], moltenColor: ["#b8ffc4", "#d4ffdc"], gasColor: ["#a8e6b2", "#c2f2ca"], category: "isotopes", meltTemp: 700, boilTemp: 1737, density: 5500, conduct: 0.5, desc: "Radioluminescent Ra-226 -> Radon -> Po-210 -> Lead.", tick: (p) => { p.temp += 0.12; if (Math.random() < 0.008) spawnParticle(p.x, p.y, "alpha_particle", 1); if (Math.random() < 0.0004) { safeChange(p, "radon"); return; } doDefaults(p); } },
    { id: "polonium_210", color: ["#8c9e99", "#9eb0ab"], moltenColor: ["#b5f5d8", "#ccffe8"], gasColor: ["#a8bfb9", "#bcd4ce"], category: "isotopes", meltTemp: 254, boilTemp: 962, density: 9196, conduct: 0.5, desc: "Intense alpha emitter -> Lead.", tick: (p) => { p.temp += 0.45; if (Math.random() < 0.02) spawnParticle(p.x, p.y, "alpha_particle", 1); if (Math.random() < 0.00025 && elements.lead) { safeChange(p, "lead"); return; } doDefaults(p); } },
    { id: "barium_141", color: ["#a3a89c", "#b5baa9"], moltenColor: ["#d9b977", "#ebca86"], gasColor: ["#cfd4c7", "#dfe3d8"], category: "isotopes", meltTemp: 727, boilTemp: 1897, density: 3510, conduct: 0.4, behavior: behaviors.POWDER, desc: "Fission daughter with delayed neutrons.", tick: (p) => { p.temp += 0.12; if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.0008) spawnNeutronsAround(p.x, p.y, 1, "thermal_neutron"); doDefaults(p); } },
    { id: "strontium_90", color: ["#c2c7b8", "#d3d9c7"], moltenColor: ["#e6c373", "#f2d183"], gasColor: ["#e0e3d8", "#edf0e6"], category: "isotopes", meltTemp: 777, boilTemp: 1382, density: 2640, conduct: 0.45, behavior: behaviors.POWDER, desc: "RTG beta heat source.", tick: (p) => { p.temp += 0.08; if (Math.random() < 0.004) spawnParticle(p.x, p.y, "beta_particle", 1); doDefaults(p); } },
    { id: "cesium_135", color: ["#d9c27e", "#e6cf8c"], moltenColor: ["#f0d88b", "#fce597"], gasColor: ["#ebdcb0", "#f5e8c1"], category: "isotopes", meltTemp: 28.5, boilTemp: 671, density: 1930, conduct: 0.65, behavior: behaviors.POWDER, desc: "Long-lived Cesium-135." },
    { id: "beryllium", color: ["#8c9c94", "#9eb0a7", "#7d8c85"], moltenColor: ["#d99b66", "#eba971"], gasColor: ["#b5c4bc", "#c8d6cf"], category: "nuclear", meltTemp: 1287, boilTemp: 2470, density: 1850, conduct: 0.75, hardness: 0.8, desc: "Neutron reflector & (n,2n) multiplier.", reactions: { polonium_210: { chance: 0.08, func: p1 => { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 15; } }, americium_241: { chance: 0.05, func: p1 => { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 10; } } } },
    { id: "boron", color: ["#3a3330", "#4a413d", "#2e2826"], moltenColor: ["#b85e37", "#cc6b41"], gasColor: ["#786c67", "#8a7c76"], category: "nuclear", meltTemp: 2076, boilTemp: 3927, density: 2340, conduct: 0.15, hardness: 0.92, tickAllStates: true, desc: "Control rod & aneutronic p-B11 fusion fuel (>55,000 C).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 55000 && Math.random() < 0.2 * fr) { const h = findAdjacentElement(p, "hydrogen"); if (h) { safeChange(p, "helium"); safeChange(h, "helium"); p.temp += 9500; h.temp += 9500; return; } } doDefaults(p); } },
    { id: "cadmium", color: ["#9da8b8", "#adb8c9", "#8c96a6"], moltenColor: ["#cfd6e0", "#dfe6f0"], gasColor: ["#b8c2d1", "#cbd4e3"], category: "nuclear", meltTemp: 321, boilTemp: 767, density: 8650, conduct: 0.7, hardness: 0.45, desc: "Control-rod neutron absorber." },
    { id: "hafnium", color: ["#7a8491", "#8b95a3", "#697380"], moltenColor: ["#eb9952", "#ffa963"], gasColor: ["#a3adb8", "#b6c0cc"], category: "nuclear", meltTemp: 2233, boilTemp: 4603, density: 13310, conduct: 0.55, hardness: 0.88, desc: "High-temp control rod absorber." },
    { id: "tungsten", color: ["#5b616b", "#6b727d", "#4d525c"], moltenColor: ["#fff3b0", "#fff9d4"], gasColor: ["#a8b0bd", "#bcc4d1"], category: "metals", meltTemp: 3422, boilTemp: 5555, density: 19250, conduct: 0.78, hardness: 0.96, desc: "Highest-melting pure metal (3,422 C)." },
    { id: "lithium_6", color: ["#b8bcc2", "#c7cbd1"], moltenColor: ["#e0c59b", "#f0d4a8"], gasColor: ["#d6dae0", "#e6e9f0"], category: "isotopes", meltTemp: 180.5, boilTemp: 1342, density: 460, conduct: 0.6, hardness: 0.25, desc: "Breeds Tritium + He-4 from neutrons.", reactions: { water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: p1 => { p1.temp += 300; } } } },
    { id: "lithium_7", color: ["#aeb3ba", "#bfc4cc"], moltenColor: ["#d9be93", "#e8cca0"], gasColor: ["#cfd4db", "#dfe4eb"], category: "isotopes", meltTemp: 180.5, boilTemp: 1342, density: 534, conduct: 0.6, hardness: 0.25, desc: "Low-absorption Lithium-7.", reactions: { water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: p1 => { p1.temp += 300; } } } },
    { id: "nickel", color: ["#a8a89e", "#babab0", "#96968c"], moltenColor: ["#eb9a52", "#ffa961"], gasColor: ["#c7c7bd", "#d9d9cf"], category: "metals", meltTemp: 1455, boilTemp: 2913, density: 8908, conduct: 0.72, hardness: 0.75, behavior: behaviors.POWDER, desc: "Ferromagnetic metal (Curie: 358 C)." },
    { id: "cobalt", color: ["#587196", "#6682ab", "#4c6282"], moltenColor: ["#e6863e", "#f59851"], gasColor: ["#8da2c2", "#9fb4d4"], category: "metals", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.72, hardness: 0.78, behavior: behaviors.POWDER, desc: "Ferromagnetic metal (Curie: 1,115 C); activates to Co-60." },
    { id: "cobalt_60", color: ["#3b6eff", "#5985ff", "#2c5be6"], moltenColor: ["#7aa2ff", "#99b8ff"], gasColor: ["#6b93ff", "#88a8ff"], category: "isotopes", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.72, hardness: 0.78, desc: "Intense gamma emitter.", tick: (p) => { p.temp += 0.25; if (Math.random() < 0.015) spawnParticle(p.x, p.y, "gamma_ray", 1); doDefaults(p); } },
    { id: "neodymium", color: ["#8c929c", "#9da4b0"], moltenColor: ["#eb9b5e", "#ffa96e"], gasColor: ["#b4bac4", "#c5cbd6"], category: "metals", meltTemp: 1024, boilTemp: 3074, density: 7010, conduct: 0.5, hardness: 0.65, behavior: behaviors.POWDER, desc: "Rare-earth magnetic metal (Curie: 310 C)." },
    { id: "gadolinium", color: ["#a3b4bd", "#b5c6cf"], moltenColor: ["#e6aa6e", "#f5bb7f"], gasColor: ["#c7d6de", "#d9e6ed"], category: "metals", meltTemp: 1313, boilTemp: 3273, density: 7900, conduct: 0.45, hardness: 0.6, behavior: behaviors.POWDER, desc: "Magnetic thermal switch (Curie: 20 C)." },
    { id: "bismuth", color: ["#c7a4d6", "#9be3d8", "#f0c88c"], moltenColor: ["#d9d4e3", "#ebe6f5"], gasColor: ["#e0d5eb", "#efe6fa"], category: "metals", meltTemp: 271.4, boilTemp: 1564, density: 9780, conduct: 0.25, hardness: 0.4, behavior: behaviors.POWDER, desc: "Strongest room-temp diamagnet (weakly repelled by magnets)." },
    { id: "platinum", color: ["#d6dce3", "#e5ebf2", "#c4cbd4"], moltenColor: ["#ffe1b8", "#ffedd4"], gasColor: ["#e6ecf2", "#f2f7fc"], category: "metals", meltTemp: 1768, boilTemp: 3825, density: 21450, conduct: 0.85, hardness: 0.8, desc: "Catalyzes H2+O2 ignition and Haber Ammonia synthesis (350-650 C).", tick: (p) => { if (Math.random() < 0.25) { const h = findAdjacentElement(p, "hydrogen"); if (h) { const o = findAdjacentElement(p, "oxygen"); if (o) { safeChange(h, "steam"); safeChange(o, "fire"); p.temp += 120; return; } if (p.temp >= 350 && p.temp <= 650 && elements.ammonia) { const n = findAdjacentElement(p, "nitrogen"); if (n) { safeChange(h, "ammonia"); safeChange(n, "ammonia"); p.temp += 60; return; } } } } doDefaults(p); } },
    { id: "cesium", color: ["#e3cf86", "#edda95", "#d4bf77"], moltenColor: ["#f5e29d", "#ffedab"], gasColor: ["#f2e6bd", "#fcf1cc"], category: "metals", meltTemp: 28.5, boilTemp: 671, density: 1930, conduct: 0.72, hardness: 0.1, behavior: behaviors.POWDER, desc: "Melts at 28.5 C; explodes with water/ice.", reactions: { water: { chance: 0.9, func: p1 => { safeChange(p1, "hydrogen"); p1.temp += 1200; explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } }, ice: { chance: 0.7, func: p1 => { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } }, oxygen: { elem1: "fire", elem2: "ash", tempMin: 35, chance: 0.35 } } },
    { id: "rubidium", color: ["#c9cfd6", "#d8dee6"], moltenColor: ["#dfe5ed", "#edf2f7"], gasColor: ["#cfd6de", "#dee4eb"], category: "metals", meltTemp: 39.3, boilTemp: 688, density: 1532, conduct: 0.7, hardness: 0.12, behavior: behaviors.POWDER, desc: "Explodes on contact with water.", reactions: { water: { chance: 0.85, func: p1 => { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 3, "fire,hydrogen,steam"); } } } },
    { id: "gallium", color: ["#b4c2d1", "#c5d2e0", "#a4b2c2"], moltenColor: ["#d4e0ed", "#e3edf7"], gasColor: ["#c7d4e3", "#d8e4f2"], category: "metals", meltTemp: 29.8, boilTemp: 2400, density: 5910, conduct: 0.65, hardness: 0.35, desc: "Melts at 29.8 C; embrittles Aluminum.", reactions: { aluminum: { elem2: "metal_scrap", chance: 0.25 } } },
    { id: "phosphorus_white", color: ["#f5f0c4", "#fffad1", "#e8e2b0"], moltenColor: ["#fff49e", "#fff9ba"], gasColor: ["#f0ebb9", "#faf5c8"], category: "chemistry", meltTemp: 44.1, boilTemp: 280.5, density: 1823, conduct: 0.05, hardness: 0.2, behavior: behaviors.POWDER, desc: "Pyrophoric (>30 C in O2); converts to Red Phosphorus >250 C without O2.", tick: (p) => { if (p.temp >= 250 && p.temp < 400 && Math.random() < 0.04 && !findAdjacentElement(p, "oxygen")) { safeChange(p, "phosphorus_red"); return; } doDefaults(p); }, reactions: { oxygen: { elem1: "fire", elem2: "smoke", tempMin: 30, chance: 0.5, func: p1 => { p1.temp += 800; } } } },
    { id: "phosphorus_red", color: ["#9e2b25", "#b5352e", "#87221d"], moltenColor: ["#d94a38", "#eb5a46"], gasColor: ["#f0ebb9", "#faf5c8"], category: "chemistry", meltTemp: 590, boilTemp: 620, density: 2340, conduct: 0.05, hardness: 0.35, behavior: behaviors.POWDER, desc: "Stable Red Phosphorus.", reactions: { oxygen: { elem1: "fire", elem2: "smoke", tempMin: 260, chance: 0.35, func: p1 => { p1.temp += 700; } } } },
    { id: "alumina", color: ["#e8ecf0", "#f2f5f7", "#d8dde3"], moltenColor: ["#ffcf9e", "#ffe0bd"], gasColor: ["#e6eaed", "#f5f8fa"], category: "chemistry", meltTemp: 2072, boilTemp: 2977, density: 3950, conduct: 0.1, hardness: 0.9, behavior: behaviors.POWDER, desc: "Al2O3 ceramic slag from Thermite." },
    { id: "osmium", color: ["#526075", "#5f6e85", "#465366"], moltenColor: ["#e69653", "#f5a764"], gasColor: ["#7c8ba3", "#8d9cb5"], category: "metals", meltTemp: 3033, boilTemp: 5012, density: 22590, conduct: 0.7, hardness: 0.95, desc: "Densest natural element on Earth." }
  ];
  FULL_ELEMENTS.forEach(defineFullElement);

  // ---------------------------------------------------------------------------
  // 9. BUILT-IN DARK-MODE IN-GAME SETTINGS PANEL + BETTERSETTINGS SYNC
  // ---------------------------------------------------------------------------

  const uiControls = {};
  let statsEl = null, panelEl = null;

  function syncSettingsUI() {
    for (const key of Object.keys(uiControls)) {
      const c = uiControls[key];
      if (!c) continue;
      if (c.type === "checkbox") c.checked = !!UPC_CONFIG[key];
      else c.value = String(UPC_CONFIG[key]);
      if (c._valLabel) c._valLabel.textContent = String(UPC_CONFIG[key]);
    }
  }

  function applyPreset(name) {
    const presets = {
      default: DEFAULT_CONFIG,
      stellar: { gravityMethod: "star", fieldTileSize: 4, fieldRebuildInterval: 2, gravAccel: 0.04, compressionHeatScale: 1.1, radiativeCooling: true, starDrag: 0.998, fusionRate: 1.3, supernovaEnabled: true, autoBonding: false },
      reactor: { gravityMethod: "element", fieldTileSize: 4, fieldRebuildInterval: 2, fissionHeatScale: 1.0, maxNeutrons: 480, delayedNeutrons: true, plasmaConfinement: true, autoBonding: true },
      fast:    { gravityMethod: "com", fieldTileSize: 6, fieldRebuildInterval: 4, maxNeutrons: 200, maxBonds: 300, showFields: false }
    };
    if (presets[name]) Object.assign(UPC_CONFIG, presets[name]);
    applyUPCConfig(true);
    notifyUser("Unified Physics preset applied: " + name);
  }

  function createSettingsUI() {
    if (typeof document === "undefined" || document.getElementById("upc-settings-btn")) return;
    const style = document.createElement("style");
    style.textContent = `
      #upc-settings-btn{position:fixed;top:10px;right:12px;z-index:99998;background:#181a22;color:#e6ecff;border:1px solid #3c4663;border-radius:6px;padding:6px 11px;font:600 12px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45)}
      #upc-settings-btn:hover{background:#232838;border-color:#66b2ff}
      #upc-settings-panel{position:fixed;top:44px;right:12px;z-index:99999;width:330px;max-height:calc(100vh - 64px);overflow-y:auto;background:rgba(18,20,27,.96);color:#e2e8f5;border:1px solid #343d54;border-radius:9px;padding:12px 14px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.65);display:none}
      #upc-settings-panel h3{margin:0 0 8px;font-size:14px;color:#7cc4ff;display:flex;justify-content:space-between;align-items:center}
      #upc-settings-panel .upc-sec{margin:10px 0 5px;padding-top:7px;border-top:1px solid #2b3245;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8c9bbd}
      #upc-settings-panel .upc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}
      #upc-settings-panel label{flex:1;color:#d5ddf0}
      #upc-settings-panel select,#upc-settings-panel input[type="range"]{width:140px;background:#101218;color:#eef3ff;border:1px solid #39435e;border-radius:4px;padding:2px 4px;font-size:11.5px}
      #upc-settings-panel .upc-val{width:38px;text-align:right;color:#8cd1ff;font-variant-numeric:tabular-nums}
      #upc-settings-panel .upc-presets{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 8px}
      #upc-settings-panel button.upc-act{background:#23293a;color:#dce6ff;border:1px solid #3a4563;border-radius:5px;padding:5px 7px;font-size:11px;cursor:pointer}
      #upc-settings-panel button.upc-act:hover{background:#2e3852;border-color:#7cc4ff}
      #upc-stats-bar{background:#11131a;border:1px solid #272e40;border-radius:5px;padding:6px 8px;font:11px/1.45 ui-monospace,Consolas,monospace;color:#9ad1b8;margin-bottom:6px;white-space:pre-line}
    `;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "upc-settings-btn"; btn.textContent = "Physics Settings"; btn.title = "Unified Physics Settings (Shift+P)";
    document.body.appendChild(btn);

    panelEl = document.createElement("div");
    panelEl.id = "upc-settings-panel";
    ["mousedown", "mouseup", "click", "wheel", "keydown", "keyup", "touchstart"].forEach(ev => panelEl.addEventListener(ev, e => e.stopPropagation()));
    panelEl.innerHTML = '<h3><span>Unified Physics v6.1</span><span style="cursor:pointer;color:#7e8ba8" id="upc-close-x">✕</span></h3>';

    statsEl = document.createElement("div"); statsEl.id = "upc-stats-bar";
    statsEl.textContent = "Tick: 0.00 ms | Moving: 0\nTiles G:0 B:0 | Bonds:0 | n:0";
    panelEl.appendChild(statsEl);

    const pRow = document.createElement("div"); pRow.className = "upc-presets";
    [["default", "Balanced Default"], ["stellar", "Stellar / Supernova"], ["reactor", "Reactor & Chem"], ["fast", "High-FPS Mode"]].forEach(([id, txt]) => {
      const b = document.createElement("button"); b.className = "upc-act"; b.textContent = txt; b.onclick = () => applyPreset(id); pRow.appendChild(b);
    });
    panelEl.appendChild(pRow);

    const addSec = (t) => { const d = document.createElement("div"); d.className = "upc-sec"; d.textContent = t; panelEl.appendChild(d); };
    const addSel = (lbl, key, opts) => {
      const r = document.createElement("div"); r.className = "upc-row";
      const l = document.createElement("label"); l.textContent = lbl;
      const s = document.createElement("select");
      opts.forEach(([v, tx]) => { const o = document.createElement("option"); o.value = String(v); o.textContent = tx; s.appendChild(o); });
      s.value = String(UPC_CONFIG[key]);
      s.onchange = () => { const n = Number(s.value); UPC_CONFIG[key] = Number.isNaN(n) ? s.value : n; applyUPCConfig(true); };
      uiControls[key] = s; r.append(l, s); panelEl.appendChild(r);
    };
    const addSld = (lbl, key, min, max, step) => {
      const r = document.createElement("div"); r.className = "upc-row";
      const l = document.createElement("label"); l.textContent = lbl;
      const inp = document.createElement("input"); inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = UPC_CONFIG[key];
      const v = document.createElement("span"); v.className = "upc-val"; v.textContent = String(UPC_CONFIG[key]); inp._valLabel = v;
      inp.oninput = () => { UPC_CONFIG[key] = Number(inp.value); v.textContent = inp.value; applyUPCConfig(true); };
      uiControls[key] = inp; r.append(l, inp, v); panelEl.appendChild(r);
    };
    const addTgl = (lbl, key) => {
      const r = document.createElement("div"); r.className = "upc-row";
      const l = document.createElement("label"); l.textContent = lbl;
      const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!UPC_CONFIG[key];
      c.onchange = () => { UPC_CONFIG[key] = c.checked; applyUPCConfig(true); };
      uiControls[key] = c; r.append(l, c); panelEl.appendChild(r);
    };

    addSec("Gravity & CIC Tile Engine");
    addSel("Gravity Method", "gravityMethod", [["element", "Element-Based (star_gravity/wells)"], ["star", "Multi-Body CIC (Always On)"], ["com", "Fast Center-of-Mass"], ["wells_only", "Gravity Wells / Cores Only"], ["off", "Off (Vanilla Only)"]]);
    addSel("Tile Resolution", "fieldTileSize", [[2, "2x2 (Ultra Sharp)"], [4, "4x4 (Balanced)"], [6, "6x6 (Fast)"], [8, "8x8 (Max FPS)"]]);
    addSld("Rebuild Every (ticks)", "fieldRebuildInterval", 1, 6, 1);
    addSld("Gravity Strength", "gravAccel", 0, 0.12, 0.004);
    addSld("Gas Compression Heat", "compressionHeatScale", 0, 2.5, 0.1);
    addTgl("Stellar Radiative Cooling", "radiativeCooling");
    addSld("Max Pixel Speed", "maxSpeed", 0.5, 3.5, 0.1);
    addSld("Orbital Drag", "starDrag", 0.94, 1.0, 0.002);

    addSec("Magnets & Plasma");
    addSld("Magnetic Strength", "magScale", 0, 3.0, 0.1);
    addTgl("Tokamak Plasma Confinement", "plasmaConfinement");
    addTgl("Curie Temp Demagnetization", "curieDemagnetize");
    addTgl("Show Field Vectors Overlay", "showFields");

    addSec("Nuclear & Fusion");
    addSld("Fusion Rate", "fusionRate", 0, 3.0, 0.1);
    addSld("Fission Heat Scale", "fissionHeatScale", 0.2, 3.0, 0.1);
    addSld("Neutron Cap", "maxNeutrons", 60, 800, 20);
    addTgl("Delayed Neutrons", "delayedNeutrons");
    addTgl("Supernova Core Collapse", "supernovaEnabled");

    addSec("Chemical Bonding");
    addTgl("Auto Chemical Bonding", "autoBonding");
    addTgl("Render Bond Lines", "showBonds");
    addSld("Max Bond Edges", "maxBonds", 0, 1800, 50);

    const aRow = document.createElement("div"); aRow.className = "upc-presets";
    const cbBtn = document.createElement("button"); cbBtn.className = "upc-act"; cbBtn.textContent = "Break All Bonds";
    cbBtn.onclick = () => { clearAllBonds(); notifyUser("Cleared all chemical bonds."); };
    const zvBtn = document.createElement("button"); zvBtn.className = "upc-act"; zvBtn.textContent = "Zero All Velocity";
    zvBtn.onclick = () => {
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (p) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; p.inwardImpulse = 0; }
      }
      movingPixelsLastTick = 0; notifyUser("Zeroed velocity on all pixels.");
    };
    aRow.append(cbBtn, zvBtn); panelEl.appendChild(aRow);
    document.body.appendChild(panelEl);

    const togglePanel = () => {
      const open = panelEl.style.display === "block";
      panelEl.style.display = open ? "none" : "block";
      if (!open) syncSettingsUI();
    };
    btn.onclick = (e) => { e.stopPropagation(); togglePanel(); };
    const cx = document.getElementById("upc-close-x");
    if (cx) cx.onclick = togglePanel;

    window.addEventListener("keydown", (e) => {
      if (e.shiftKey && (e.key === "P" || e.key === "p")) {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault(); togglePanel();
      }
    });

    setInterval(() => {
      if (!panelEl || panelEl.style.display !== "block" || !statsEl) return;
      statsEl.textContent =
        `Tick: ${UPC_STATS.lastTickMs.toFixed(2)} ms | Moving: ${UPC_STATS.movingPixels}\n` +
        `Tiles G:${UPC_STATS.activeGravTiles} B:${UPC_STATS.activeMagTiles} | Bonds:${UPC_STATS.activeBonds} | n:${UPC_STATS.activeNeutrons}`;
    }, 450);
  }

  function registerBetterSettingsTab() {
    if (typeof SettingsTab !== "function" || typeof settingsManager === "undefined") return;
    try {
      const tab = new SettingsTab("Unified Physics");
      const bind = (s, key) => {
        if (s && typeof s.onUpdate === "function") s.onUpdate(val => { UPC_CONFIG[key] = val; applyUPCConfig(true); });
        if (typeof tab.registerSetting === "function") tab.registerSetting(s);
      };
      bind(new SelectSetting("Gravity Method", "upc_grav_method", [["element", "Element-Based"], ["star", "Multi-Body CIC Always On"], ["com", "Fast Center-of-Mass"], ["wells_only", "Wells/Cores Only"], ["off", "Off"]]), "gravityMethod");
      bind(new SelectSetting("Gravity/Magnet Tile Size", "upc_tile_size", [[2, "2x2"], [4, "4x4"], [6, "6x6"], [8, "8x8"]]), "fieldTileSize");
      if (typeof Setting === "function" && typeof settingType !== "undefined") {
        bind(new Setting("Auto Chemical Bonding", "upc_auto_bond", settingType.BOOLEAN, false, UPC_CONFIG.autoBonding), "autoBonding");
        bind(new Setting("Show Field Vectors", "upc_show_fields", settingType.BOOLEAN, false, UPC_CONFIG.showFields), "showFields");
      }
      settingsManager.registerTab(tab);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 10. PATCH VANILLA & CHEM.JS + RECURSIVE TICK SANITIZER + GLOBAL HOOKS
  // ---------------------------------------------------------------------------

  function initUnifiedPhysics() {
    applyUPCConfig(false);

    if (!elements.iron_gas) {
      registerOrEnhance("iron_gas", { color: ["#ffb870", "#ffc98f"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 7.8, temp: 2950, tempLow: 2862, stateLow: "molten_iron" });
    }
    if (elements.molten_iron && !elements.molten_iron.stateHigh) {
      elements.molten_iron.tempHigh = 2862; elements.molten_iron.stateHigh = "iron_gas";
    }

    if (elements.neutron) {
      elements.neutron.desc = "Free neutron (enhanced by Unified Physics & Chemistry v6.1).";
      if (!elements.neutron.reactions) elements.neutron.reactions = {};
      delete elements.neutron.tick1; delete elements.neutron.tick2;
      elements.neutron.tick = (p) => neutronTick(p, true);
    }
    if (elements.uranium) {
      elements.uranium.desc = "Natural/Low-Enriched Uranium (patched). Requires moderated thermal neutrons.";
      delete elements.uranium.tick1; delete elements.uranium.tick2;
      elements.uranium.tick = (p) => { if (Math.random() < 0.0001) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); };
    }
    if (elements.plutonium) {
      elements.plutonium.desc = "Plutonium-239 (patched). Self-heats via alpha decay; fissions on thermal & fast neutrons.";
      delete elements.plutonium.tick1; delete elements.plutonium.tick2;
      elements.plutonium.tick = (p) => { p.temp += 0.05; if (Math.random() < 0.0005) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); };
    }

    // Stellar Fusion Hooks on Vanilla Gases (compression-scaled & crash-proof)
    if (elements.hydrogen) {
      wrapTick("hydrogen", (p) => {
        const fr = getFusionFactor(p);
        if (fr > 0 && p.temp >= 50000 && Math.random() < 0.16 * fr) {
          const o = findAdjacentElement(p, "hydrogen");
          if (o) { safeChange(p, "deuterium"); safeChangeAny(o, ["positron", "gamma_ray", "radiation"]); p.temp += 4000; o.temp += 4000; return true; }
        }
        return false;
      });
    }
    if (elements.helium) {
      wrapTick("helium", (p) => {
        const fr = getFusionFactor(p);
        if (fr > 0 && p.temp >= 65000 && Math.random() < 0.15 * fr) {
          const o = findAdjacentElement(p, "helium");
          if (o) { safeChange(p, "carbon_vapor"); safeChange(o, "gamma_ray"); p.temp += 5500; o.temp += 5500; return true; }
        }
        return false;
      });
    }
    if (elements.oxygen) {
      wrapTick("oxygen", (p) => {
        const fr = getFusionFactor(p);
        if (fr > 0 && p.temp >= 95000 && Math.random() < 0.16 * fr) {
          const o = findAdjacentElement(p, "oxygen");
          if (o) {
            if (Math.random() < 0.75) safeChange(p, "silicon_gas");
            else safeChangeAny(p, ["sulfur_gas", "molten_sulfur", "sulfur", "silicon_gas"]);
            safeChange(o, "gamma_ray"); p.temp += 4000; o.temp += 4000; return true;
          }
        }
        return false;
      });
    }

    // High-Temperature Thermal Dissociation
    if (elements.carbon_dioxide) wrapTick("carbon_dioxide", (p) => (p.temp >= 4000 && Math.random() < 0.25 ? (safeChange(p, Math.random() < 0.5 ? "carbon_vapor" : "oxygen"), true) : false));
    if (elements.steam) wrapTick("steam", (p) => (p.temp >= 3200 && Math.random() < 0.20 ? (safeChange(p, Math.random() < 0.66 ? "hydrogen" : "oxygen"), true) : false));
    if (elements.ammonia) wrapTick("ammonia", (p) => (p.temp >= 1200 && Math.random() < 0.22 ? (safeChange(p, Math.random() < 0.75 ? "hydrogen" : "nitrogen"), true) : false));
    if (elements.sand) wrapTick("sand", (p) => (p.temp >= 4500 && Math.random() < 0.18 ? (safeChange(p, Math.random() < 0.45 ? "silicon_gas" : "oxygen"), true) : false));

    // Thermite (Rust + Aluminum > 1,200 C) & chem.js Uranium Dioxide integration
    if (elements.rust && elements.aluminum) {
      safeAddReaction("rust", "aluminum", { elem1: "molten_iron", elem2: "alumina", tempMin: 1200, chance: 0.45, func: (p1, p2) => { p1.temp += 1800; p2.temp += 1800; } });
    }
    if (elements.uranium_dioxide) {
      FISSILE_SPECS.uranium_dioxide = { th: 0.45, fa: 0.04, n: [2, 3], heat: 1850, d: ["barium_141", "krypton_92", "xenon_135"] };
    }

    // Global simulation tick & render hooks
    if (typeof window !== "undefined" && typeof window.tickPixels === "function" && !window.tickPixels._upcWrapped) {
      const origTick = window.tickPixels;
      const wrappedTick = function (...args) {
        const res = origTick.apply(this, args);
        const t0 = performance.now();
        try { updateGravityAndCompressionTick(); updateBondsTick(); }
        catch (err) { console.error("[UPC] global tick error:", err); }
        UPC_STATS.lastTickMs = performance.now() - t0;
        return res;
      };
      wrappedTick._upcWrapped = true;
      window.tickPixels = wrappedTick;
    }

    if (typeof window !== "undefined" && typeof window.drawPixels === "function" && !window.drawPixels._upcWrapped) {
      const origDraw = window.drawPixels;
      const wrappedDraw = function (...args) {
        const res = origDraw.apply(this, args);
        try { drawFieldOverlay(); drawActiveBonds(); } catch (err) {}
        return res;
      };
      wrappedDraw._upcWrapped = true;
      window.drawPixels = wrappedDraw;
    }

    // Supernova recursive tick1/tick2 cycle breaker
    function sanitizeElementTicks() {
      const fixed = [];
      for (const key in elements) {
        const el = elements[key];
        if (!el || el.tool) continue;
        if (el.tick !== undefined && typeof el.tick !== "function") delete el.tick;
        const bad1 = typeof el.tick1 === "function" && (el.tick1 === el.tick || String(el.tick1).includes("tick1"));
        const bad2 = typeof el.tick2 === "function" && (el.tick2 === el.tick || String(el.tick2).includes("tick1") || String(el.tick2).includes("tick2"));
        if (bad1 || bad2) {
          fixed.push(key);
          if (!bad2 && typeof el.tick2 === "function") el.tick = el.tick2;
          else if (!bad1 && typeof el.tick1 === "function") el.tick = el.tick1;
          else delete el.tick;
          delete el.tick1; delete el.tick2;
        }
        if (!el.reactions) el.reactions = {};
        if (!el.behavior && !el.tick) el.behavior = el.state === "liquid" ? behaviors.LIQUID : el.state === "gas" ? behaviors.GAS : behaviors.WALL;
      }
      if (fixed.length) console.warn("[UPC] Broke recursive tick1 loop on:", fixed);
    }

    sanitizeElementTicks();
    setTimeout(sanitizeElementTicks, 250);

    createSettingsUI();
    if (typeof SettingsTab === "function") registerBetterSettingsTab();
    else if (typeof dependOn === "function") dependOn("betterSettings.js", registerBetterSettingsTab, true);

    console.log("[unified_physics_chem] Loaded v6.1 successfully!");
  }

  if (typeof runAfterLoad === "function") runAfterLoad(initUnifiedPhysics);
  else initUnifiedPhysics();
})();
