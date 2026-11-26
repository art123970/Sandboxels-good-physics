/*
 * Unified Physics & Chemistry v8 (unified_physics_chem.js)
 * Companion add-on for Sandboxels + chem.js
 * - Quiet non-blocking toast notifications (zero intrusive popups)
 * - Oxygen -> Ozone high-temp fix (caps ozone <= 350 C & decomposes hot ozone -> oxygen)
 * - True Voxel Mass-Packing Compression (p.pack): voxels physically merge under gravity & split
 *   under thermal expansion, with merge caps for smooth stellar contraction & staged fusion pauses
 * - Degeneracy Collapse: high pack -> Neutron Star (neutronium) + gigantic 44-68px Supernova;
 *   extreme pack / TOV accretion overload -> Black Hole (black_hole_core)
 * - CIC 2x2..8x8 Gravity & Magnetic Tiles + Per-Pixel Velocity + External-Map Bond Graph
 * - Paced fusion/fission/decay + Supernova recursive tick1/tick2 breaker + Dark Settings UI (Shift+P)
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. LIVE CONFIGURATION, PERSISTENCE & QUIET TOAST
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "upc_v8_settings";
  const DEFAULT_CONFIG = {
    gravityMethod: "element",     // "element" | "star" | "com" | "wells_only" | "off"
    fieldTileSize: 4,             // 2 | 4 | 6 | 8
    fieldRebuildInterval: 2,      // 1..6 ticks
    gravAccel: 0.032,
    compressionHeatScale: 1.0,
    radiativeCooling: true,
    collapseThresholdScale: 1.0,
    showPackGlow: true,
    magScale: 1.0,
    maxSpeed: 2.6,
    starDrag: 0.996,
    fusionRate: 1.0,
    fissionRate: 1.0,
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

  const BASE_NS_PACK = 14;
  const BASE_BH_PACK = 55;
  const MAX_PACK = 90;

  const UPC_STATS = {
    lastTickMs: 0, activeGravTiles: 0, activeMagTiles: 0,
    movingPixels: 0, activeNeutrons: 0, activeBonds: 0,
    maxPack: 1, lastEvent: "Ready"
  };

  let toastEl = null, toastTimer = null;
  function notifyUser(msg, showToast = false) {
    UPC_STATS.lastEvent = msg;
    if (showToast && toastEl) {
      toastEl.textContent = msg;
      toastEl.style.opacity = "1";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = "0"; }, 2600);
    }
  }

  function applyUPCConfig(persist = true) {
    const nb = Math.max(2, Math.min(8, parseInt(UPC_CONFIG.fieldTileSize, 10) || 4));
    if (nb !== FIELD_BLOCK) { FIELD_BLOCK = nb; kernelX = null; }
    FIELD_REBUILD_INTERVAL = Math.max(1, Math.min(6, parseInt(UPC_CONFIG.fieldRebuildInterval, 10) || 2));
    const ga = Number(UPC_CONFIG.gravAccel);
    GRAV_ACCEL = Number.isNaN(ga) ? DEFAULT_CONFIG.gravAccel : Math.max(0, Math.min(0.25, ga));
    const cs = Number(UPC_CONFIG.compressionHeatScale);
    UPC_CONFIG.compressionHeatScale = Number.isNaN(cs) ? 1.0 : Math.max(0, Math.min(2.5, cs));
    const ct = Number(UPC_CONFIG.collapseThresholdScale);
    UPC_CONFIG.collapseThresholdScale = Number.isNaN(ct) ? 1.0 : Math.max(0.3, Math.min(3.0, ct));
    const ms = Number(UPC_CONFIG.magScale);
    const sms = Number.isNaN(ms) ? 1.0 : Math.max(0, Math.min(4.0, ms));
    MAG_POLE_ACCEL = 0.18 * sms; MAG_FERRO_ACCEL = 0.55 * sms; MAG_MEISSNER_ACCEL = 0.72 * sms;
    MAG_DIAMAG_ACCEL = 0.14 * sms; MAG_PLASMA_ACCEL = 0.45 * sms;
    MAX_SPEED = Math.max(0.5, Math.min(3.5, Number(UPC_CONFIG.maxSpeed) || 2.6));
    MAX_NEUTRONS = Math.max(40, Math.min(800, parseInt(UPC_CONFIG.maxNeutrons, 10) || 320));
    MAX_BONDS = Math.max(0, Math.min(2000, parseInt(UPC_CONFIG.maxBonds, 10) || 700));
    UPC_CONFIG.starDrag = Math.max(0.85, Math.min(1.0, Number(UPC_CONFIG.starDrag) || 0.996));
    const fr = Number(UPC_CONFIG.fusionRate);
    UPC_CONFIG.fusionRate = Number.isNaN(fr) ? 1.0 : Math.max(0, Math.min(3.0, fr));
    const fisr = Number(UPC_CONFIG.fissionRate);
    UPC_CONFIG.fissionRate = Number.isNaN(fisr) ? 1.0 : Math.max(0.1, Math.min(3.0, fisr));
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
    const start = Math.floor(Math.random() * 8), isSet = target instanceof Set;
    for (let i = 0; i < 8; i++) {
      const d = NON_ZERO_DIRS[(start + i) & 7], nx = pixel.x + d[0], ny = pixel.y + d[1];
      if (!inSafeBounds(nx, ny)) continue;
      const o = pixelMap[nx][ny];
      if (o && !o.del && (isSet ? target.has(o.element) : o.element === target)) return o;
    }
    return null;
  }

  function getFusionFactor(pixel) {
    if (UPC_CONFIG.fusionRate <= 0) return 0;
    const pk = pixel.pack || 1;
    return UPC_CONFIG.fusionRate * Math.min(2.6, 0.72 + Math.log2(pk) * 0.55);
  }

  const LIGHT_BYPRODUCTS = new Set(["gamma_ray", "fast_neutron", "positron", "proton", "radiation"]);
  function fusePair(p1, p2, prod1, prod2, heat) {
    if (!p1 || !p2 || p1.del || p2.del) return false;
    const pk1 = p1.pack || 1, pk2 = p2.pack || 1;
    safeChange(p1, prod1);
    if (prod2 === "positron") safeChangeAny(p2, ["positron", "gamma_ray", "radiation"]);
    else if (prod2 === "proton") safeChangeAny(p2, ["proton", "hydrogen"]);
    else safeChange(p2, prod2);

    if (LIGHT_BYPRODUCTS.has(prod2)) {
      p1.pack = Math.min(MAX_PACK, +(pk1 + pk2 * 0.65).toFixed(2));
      p2.pack = 1;
    } else {
      const avg = Math.min(MAX_PACK, +((pk1 + pk2) * 0.5).toFixed(2));
      p1.pack = avg; p2.pack = avg;
    }
    p1.temp = Math.min(200000, p1.temp + heat);
    p2.temp = Math.min(200000, p2.temp + heat);
    return true;
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
      if (k === "_override" || (k === "tick" && typeof def[k] !== "function") || def[k] === undefined || def[k] === null) continue;
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
    const { id, color, moltenColor, gasColor, category = "solids", meltTemp, boilTemp, density, conduct = 0.5, hardness = 0.7, behavior = behaviors.WALL, reactions = {}, tick, tickAllStates = false, desc = "" } = cfg;
    const moltenId = "molten_" + id, gasId = id + "_gas", hasTick = typeof tick === "function";
    const sDef = { color, behavior, category, state: "solid", density, conduct, hardness, tempHigh: meltTemp, stateHigh: moltenId, reactions: Object.assign({}, reactions), desc };
    if (hasTick) sDef.tick = tick;
    registerOrEnhance(id, sDef);
    const mDef = { color: moltenColor || ["#ff7b29", "#ff9e3d", "#ffb84d"], behavior: behaviors.LIQUID, category: "states", state: "liquid", hidden: true, density: Math.round(density * 0.9), conduct: conduct * 0.8, temp: meltTemp + 50, tempLow: meltTemp, stateLow: id, tempHigh: boilTemp, stateHigh: gasId, viscosity: 14, reactions: Object.assign({}, reactions) };
    if (hasTick) mDef.tick = tick;
    registerOrEnhance(moltenId, mDef);
    const gDef = { color: gasColor || ["#d9d9d9", "#bfbfbf"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: Math.max(0.5, +(density / 1000).toFixed(2)), temp: boilTemp + 50, tempLow: boilTemp, stateLow: moltenId, reactions: Object.assign({}, reactions) };
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
    const lDef = { color: liquidColor || color, behavior: behaviors.LIQUID, category: "states", state: "liquid", hidden: true, density: Math.max(50, Math.round(density * 600)), temp: boilTemp - 5, tempHigh: boilTemp, stateHigh: id, tempLow: meltTemp, stateLow: solidId, reactions: Object.assign({}, reactions) };
    if (hasTick) lDef.tick = tick;
    registerOrEnhance(liquidId, lDef);
    const sDef = { color: solidColor || liquidColor || color, behavior: behaviors.WALL, category: "states", state: "solid", hidden: true, density: Math.max(80, Math.round(density * 750)), temp: meltTemp - 5, tempHigh: meltTemp, stateHigh: liquidId, reactions: Object.assign({}, reactions) };
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
    "hydrogen|hydrogen":   { type: "covalent", breakTemp: 3500, minTemp: -250, maxTemp: 2500, prob: 0.04, maxA: 1, maxB: 1 },
    "hydrogen|oxygen":     { type: "polar",    breakTemp: 2800, minTemp: 120,  maxTemp: 2200, prob: 0.08, maxA: 1, maxB: 2 },
    "deuterium|oxygen":    { type: "polar",    breakTemp: 2850, minTemp: 120,  maxTemp: 2200, prob: 0.08, maxA: 1, maxB: 2 },
    "chlorine|sodium":     { type: "ionic",    breakTemp: 1450, minTemp: -50,  maxTemp: 1100, prob: 0.14, maxA: 1, maxB: 1 },
    "chlorine|hydrogen":   { type: "polar",    breakTemp: 2200, minTemp: -100, maxTemp: 1600, prob: 0.08, maxA: 1, maxB: 1 },
    "nitrogen|nitrogen":   { type: "covalent", breakTemp: 5500, minTemp: -200, maxTemp: 4000, prob: 0.03, maxA: 1, maxB: 1 },
    "hydrogen|nitrogen":   { type: "polar",    breakTemp: 1300, minTemp: 350,  maxTemp: 900,  prob: 0.04, maxA: 1, maxB: 3 },
    "carbon_vapor|oxygen": { type: "covalent", breakTemp: 3800, minTemp: 600,  maxTemp: 3200, prob: 0.06, maxA: 2, maxB: 2 },
    "graphite|graphite":   { type: "covalent", breakTemp: 4200, minTemp: 800,  maxTemp: 3400, prob: 0.02, maxA: 3, maxB: 3 },
    "silicon|silicon":     { type: "covalent", breakTemp: 2600, minTemp: 200,  maxTemp: 2200, prob: 0.02, maxA: 4, maxB: 4 },
    "oxygen|silicon":      { type: "covalent", breakTemp: 3000, minTemp: 700,  maxTemp: 2400, prob: 0.05, maxA: 2, maxB: 4 },
    "magnesium|oxygen":    { type: "ionic",    breakTemp: 2800, minTemp: 400,  maxTemp: 2300, prob: 0.10, maxA: 2, maxB: 2 },
    "cesium|chlorine":     { type: "ionic",    breakTemp: 1300, minTemp: -50,  maxTemp: 900,  prob: 0.14, maxA: 1, maxB: 1 },
    "iron|oxygen":         { type: "ionic",    breakTemp: 2200, minTemp: 300,  maxTemp: 1600, prob: 0.03, maxA: 2, maxB: 2 },
    "aluminum|oxygen":     { type: "ionic",    breakTemp: 2900, minTemp: 500,  maxTemp: 2400, prob: 0.04, maxA: 3, maxB: 2 }
  };

  const getBonds = (p) => bondGraph.get(p) || null;
  const getBondCount = (p) => (bondGraph.get(p) ? bondGraph.get(p).length : 0);
  const hasBondBetween = (p1, p2) => (bondGraph.get(p1)?.some(b => b.target === p2) || false);

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
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].target === b) { arr.splice(i, 1); removed = true; }
      if (!arr.length) bondGraph.delete(a);
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
    if (arr) for (const b of arr.slice()) breakBondBetween(pixel, b.target, false);
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
        if (!p || p.del || !pBonds?.length || !inSafeBounds(p.x, p.y) || pixelMap[p.x][p.y] !== p) {
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
          if ((p.charge > 0 || t.charge > 0) && (bond.type === "ionic" || bond.type === "polar" || Math.random() < 0.3)) { breakBondBetween(p, t, true); continue; }
          if (hitRad && Math.random() < 0.25) { breakBondBetween(p, t, true); continue; }
          if (bond.type === "ionic" && hitWater && Math.random() < 0.1) { breakBondBetween(p, t, true); continue; }

          const avgT = (p.temp + t.temp) * 0.5;
          p.temp += (avgT - p.temp) * 0.2; t.temp += (avgT - t.temp) * 0.2;
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
      const samples = Math.min(45, currentPixels.length);
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
  // 4. CIC GRAVITY/MAGNET TILES + VOXEL MASS-PACKING COMPRESSION + SUPERNOVA
  // ---------------------------------------------------------------------------

  const IRON_FAMILY = new Set(["iron", "molten_iron", "iron_gas"]);
  const SUPER_R_TARGETS = new Set(["iron", "molten_iron", "iron_gas", "nickel", "molten_nickel", "nickel_gas", "cobalt", "molten_cobalt", "silicon_gas", "oxygen"]);
  const R_PRODUCTS = ["gold", "platinum", "lead", "thorium_232", "uranium_238", "uranium_235", "plutonium_239"];
  const STELLAR_GRAV_MASS = {
    hydrogen: 0.50, deuterium: 0.58, tritium: 0.64, helium_3: 0.66, helium: 0.74,
    carbon_vapor: 0.96, oxygen: 1.12, neon: 1.18, magnesium_gas: 1.28, silicon_gas: 1.48,
    nickel_56_gas: 2.05, cobalt_56_gas: 2.05, iron_gas: 2.15
  };
  const FERRO_CURIE = { iron: 770, molten_iron: 770, iron_filings: 770, steel: 750, cobalt: 1115, cobalt_60: 1115, nickel: 358, neodymium: 310, gadolinium: 20, rust: 580, metal_scrap: 750 };
  const MAGNET_POLE_MAP = { magnet_north: 1, magnet_south: -1, neodymium_north: 1, neodymium_south: -1, electromagnet_north: 1, electromagnet_south: -1, magnet_bead_n: 1, magnet_bead_s: -1 };
  const MAGNET_STRENGTH = { magnet_north: 1.0, magnet_south: -1.0, neodymium_north: 2.2, neodymium_south: -2.2, electromagnet_north: 1.9, electromagnet_south: -1.9, magnet_bead_n: 0.45, magnet_bead_s: -0.45 };
  const PLASMA_CONFINABLE = new Set(["plasma", "hydrogen", "deuterium", "tritium", "helium", "helium_3", "carbon_vapor", "oxygen", "neon", "silicon_gas"]);
  const VELOCITY_EXEMPT = new Set(["fast_neutron", "thermal_neutron", "radiation", "alpha_particle", "beta_particle", "gamma_ray", "bond_breaker", "bond_catalyst"]);

  const FIELD_SOFT_PX2 = 13.6;
  const SELF_PHI_UNIT = 4 / Math.sqrt(FIELD_SOFT_PX2);

  let fieldMw = 0, fieldMh = 0, fieldKw = 0;
  let kernelX = null, kernelY = null, kernelPhi = null;
  let macroMass = null, macroGx = null, macroGy = null, macroPhi = null, macroIronPack = null, macroHotIronPack = null;
  let macroPole = null, macroMagAbs = null, macroBx = null, macroBy = null, macroMagPot = null, macroBmag = null, macroGradBx = null, macroGradBy = null;
  const activeShockwaves = [];

  let lastFieldTick = -100, lastSupernovaTick = -200;
  let gravFieldActive = false, magFieldActive = false, starModeActive = false, visualizerActive = false, movingPixelsLastTick = 0;

  function getPixelGravMass(elemName, pack = 1) {
    if (elemName === "neutronium") return 95 + Math.max(0, pack - BASE_NS_PACK) * 2.5;
    if (elemName === "black_hole_core") return 210 + Math.max(0, pack - BASE_BH_PACK) * 3.0;
    const base = STELLAR_GRAV_MASS[elemName] !== undefined
      ? STELLAR_GRAV_MASS[elemName]
      : Math.min(4.2, Math.max(0.5, Math.pow((elements[elemName]?.density || 100) / 250, 0.45)));
    return base * Math.max(1, pack);
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
    macroPhi = new Float32Array(total); macroIronPack = new Float32Array(total); macroHotIronPack = new Float32Array(total);
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

  // Physically merge two adjacent same-element voxels -> star shrinks & compresses adiabatically!
  function mergeVoxelInto(keeper, absorbed, isGas) {
    if (!keeper || !absorbed || keeper === absorbed || keeper.del || absorbed.del) return false;
    if (keeper.element !== absorbed.element || isImmobileElement(absorbed.element)) return false;
    const kPack = keeper.pack || 1, aPack = absorbed.pack || 1;
    const newPack = kPack + aPack;
    if (newPack > MAX_PACK) return false;

    keeper.vx = ((keeper.vx || 0) * kPack + (absorbed.vx || 0) * aPack) / newPack;
    keeper.vy = ((keeper.vy || 0) * kPack + (absorbed.vy || 0) * aPack) / newPack;

    let avgT = (keeper.temp * kPack + absorbed.temp * aPack) / newPack;
    if (isGas && UPC_CONFIG.compressionHeatScale > 0) {
      const ratio = newPack / kPack;
      const tempK = Math.max(200, avgT + 273);
      avgT = Math.min(200000, avgT + (tempK * 0.52 * (ratio - 1) + 2800 * (ratio - 1)) * UPC_CONFIG.compressionHeatScale);
    }
    keeper.temp = avgT;
    keeper.pack = +newPack.toFixed(2);
    breakAllBonds(absorbed);
    deletePixel(absorbed.x, absorbed.y);
    return true;
  }

  // Physically split a packed voxel outward when thermal pressure beats gravity
  function splitPackedVoxel(p, ex, ey, isGas) {
    if (!p || p.del || (p.pack || 1) < 2 || !inSafeBounds(ex, ey) || !isEmpty(ex, ey)) return false;
    const pk = p.pack || 1;
    const half = Math.max(1, Math.floor(pk / 2));
    const rem = +(pk - half).toFixed(2);
    if (rem < 1) return false;

    const np = safeCreate(p.element, ex, ey);
    if (!np) return false;
    p.pack = rem;
    np.pack = half;

    let nt = p.temp;
    if (isGas && UPC_CONFIG.compressionHeatScale > 0 && nt > 20) {
      nt = Math.max(20, nt - (nt + 273) * 0.14 * UPC_CONFIG.compressionHeatScale);
    }
    p.temp = nt; np.temp = nt;
    np.vx = (p.vx || 0) + Math.sign(ex - p.x) * 0.55;
    np.vy = (p.vy || 0) + Math.sign(ey - p.y) * 0.55;
    movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    return true;
  }

  // Degeneracy collapse: moderate-high pack -> Neutron Star; extreme TOV pack -> Black Hole
  function checkDegeneracyCollapse(p, phiNet) {
    if (!UPC_CONFIG.supernovaEnabled || !p || p.del) return false;
    const pk = p.pack || 1, sc = UPC_CONFIG.collapseThresholdScale;
    const nsThresh = BASE_NS_PACK * sc, bhThresh = BASE_BH_PACK * sc;

    if (p.element === "neutronium") {
      if (pk >= bhThresh && phiNet >= 240) {
        safeChange(p, "black_hole_core");
        spawnParticle(p.x, p.y, "gamma_ray", 6);
        notifyUser("Neutron star crossed TOV limit -> Black Hole!", true);
        return true;
      }
      return false;
    }
    if (p.element === "black_hole_core") return false;

    if (pk >= bhThresh && phiNet >= 360) {
      triggerSupernova(p.x, p.y, true, Math.min(2.0, phiNet / 220));
      return true;
    }
    if (pk >= nsThresh && phiNet >= 105) {
      const doSN = p.temp > 15000 || IRON_FAMILY.has(p.element) || phiNet >= 150;
      safeChange(p, "neutronium");
      p.temp = Math.max(p.temp, 85000);
      if (doSN) triggerSupernova(p.x, p.y, false, Math.min(1.75, Math.max(1.05, phiNet / 150)));
      return true;
    }
    return false;
  }

  function applyStateAwareCompression(p, gx, gy, phiNet, mergeBudget) {
    const el = elements[p.element], st = el?.state || "solid", gMag = Math.hypot(gx, gy), pk = p.pack || 1;
    let surrounded = 0, emptyDx = 0, emptyDy = 0, emptyCount = 0, firstEmptyX = -1, firstEmptyY = -1;
    let sameNeighbor = null;

    const start = Math.floor(Math.random() * 8);
    for (let i = 0; i < 8; i++) {
      const d = NON_ZERO_DIRS[(start + i) & 7], cx = p.x + d[0], cy = p.y + d[1];
      if (!inSafeBounds(cx, cy) || !isEmpty(cx, cy)) {
        surrounded++;
        if (!sameNeighbor && inSafeBounds(cx, cy)) {
          const nb = pixelMap[cx][cy];
          if (nb && !nb.del && nb.element === p.element && !isImmobileElement(nb.element) && (nb.pack || 1) + pk <= MAX_PACK) sameNeighbor = nb;
        }
      } else {
        emptyDx += d[0]; emptyDy += d[1]; emptyCount++;
        if (firstEmptyX === -1) { firstEmptyX = cx; firstEmptyY = cy; }
      }
    }

    const imp = p.inwardImpulse || 0;
    p.inwardImpulse = imp * 0.45;
    const densNorm = Math.min(3.2, Math.max(0.25, Math.sqrt((el?.density || 1000) / 1000)));
    const pressureBase = phiNet > 4
      ? Math.round((phiNet * (0.65 + Math.min(2.2, gMag * 0.08)) * (surrounded / 8) * densNorm * Math.sqrt(pk) + imp * 30) * 1.35)
      : Math.round(imp * 20);
    p.pressure = pressureBase;

    if (st === "solid") {
      // SOLIDS: Zero static gravitational heating; only pack under extreme degenerate overburden
      const targetStress = Math.min(pressureBase * 0.8 + imp * 55, 1600);
      p.stress = Math.max(0, (p.stress || 0) * 0.88 + targetStress * 0.12);
      if (p.element === "graphite" && p.pressure > 220 && p.temp >= 1200 && elements.diamond) { safeChange(p, "diamond"); return; }
      if (p.element === "ice" && p.pressure > 320 && elements.water) { safeChange(p, "water"); return; }
      if (p.pressure > 620 && (el?.hardness ?? 0.7) < 0.55 && p.element === "stone" && elements.sand && Math.random() < 0.02) { safeChange(p, "sand"); return; }
      if (pk >= 2 && emptyCount >= 2 && pressureBase < 450 && Math.random() < 0.15) { splitPackedVoxel(p, firstEmptyX, firstEmptyY, false); return; }
      if (mergeBudget.left > 0 && sameNeighbor && pressureBase > 850 && phiNet > 160 && surrounded >= 6 && Math.random() < 0.03) {
        if (mergeVoxelInto(p, sameNeighbor, false)) { mergeBudget.left--; checkDegeneracyCollapse(p, phiNet); }
        return;
      }
      if (p.stress > 110 && emptyCount >= 3 && !isImmobileElement(p.element)) {
        const len = Math.hypot(emptyDx, emptyDy) || 1, kick = Math.min(0.9, p.stress / 340);
        p.vx = (p.vx || 0) + (emptyDx / len) * kick; p.vy = (p.vy || 0) + (emptyDy / len) * kick; p.stress *= 0.35;
      }
      return;
    }

    if (st === "liquid") {
      p.stress = Math.round(pressureBase * 0.4);
      if (pk >= 2 && emptyCount > 0 && pressureBase < 500 && Math.random() < 0.2) { splitPackedVoxel(p, firstEmptyX, firstEmptyY, false); return; }
      if (imp > 0.12 && emptyCount > 0 && gMag > 0.08) {
        const tx = -gy / gMag, ty = gx / gMag, sign = (tx * emptyDx + ty * emptyDy) >= 0 ? 1 : -1, flow = Math.min(0.85, imp * 0.55);
        p.vx = (p.vx || 0) + tx * sign * flow; p.vy = (p.vy || 0) + ty * sign * flow;
      }
      return;
    }

    // GASES & PLASMA: True Voxel Mass-Packing Equation of State
    if (UPC_CONFIG.radiativeCooling && starModeActive && p.temp > 2500) {
      p.temp = Math.max(20, p.temp - (p.temp - 2500) * (surrounded < 6 ? 0.0045 : 0.0011));
    }

    const tempK = Math.max(200, p.temp + 273);
    const pTherm = Math.pow(tempK, 0.72) * 0.032 * Math.pow(pk, 0.75);
    const pGrav = surrounded >= 5 ? Math.max(0, phiNet - 14) * (2.35 + Math.min(2.2, imp * 1.1) + Math.min(1.0, gMag * 0.05)) : 0;
    p.stress = Math.round(Math.max(0, pGrav - pTherm));

    // Compress: gravity beats thermal pressure -> merge voxels so star physically shrinks
    if (pGrav > pTherm * 1.08 && surrounded >= 5 && sameNeighbor && mergeBudget.left > 0) {
      const excess = Math.min(1.5, (pGrav - pTherm) / Math.max(35, pGrav));
      const ironBoost = IRON_FAMILY.has(p.element) ? 2.6 : 1.0;
      const mergeProb = Math.min(0.28, (0.012 + Math.min(0.055, imp * 0.04)) * excess * ironBoost);
      if (Math.random() < mergeProb && mergeVoxelInto(p, sameNeighbor, true)) {
        mergeBudget.left--;
        checkDegeneracyCollapse(p, phiNet);
        return;
      }
    }

    // Expand: over-pressurized or unconfined packed gas -> split voxels outward
    if (pk >= 2 && firstEmptyX !== -1 && (surrounded < 5 || pTherm > pGrav * 1.12)) {
      const splitProb = surrounded < 5 ? 0.22 : Math.min(0.18, 0.025 + ((pTherm - pGrav) / Math.max(50, pTherm)) * 0.14);
      if (Math.random() < splitProb) { splitPackedVoxel(p, firstEmptyX, firstEmptyY, true); return; }
    }

    if (pk >= BASE_NS_PACK * UPC_CONFIG.collapseThresholdScale) checkDegeneracyCollapse(p, phiNet);
  }

  function triggerSupernova(cx, cy, formBlackHole = false, power = 1.2) {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t - lastSupernovaTick < 90) return;
    lastSupernovaTick = t;

    const coreElem = formBlackHole ? "black_hole_core" : "neutronium";
    const coreR2 = formBlackHole ? 4 : 6;
    const basePack = (formBlackHole ? BASE_BH_PACK : BASE_NS_PACK) * UPC_CONFIG.collapseThresholdScale;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx * dx + dy * dy > coreR2) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (p && !p.del) { safeChange(p, coreElem); p.temp = 140000; p.pack = Math.max(p.pack || 1, basePack); }
        else if (isEmpty(nx, ny)) { const np = safeCreate(coreElem, nx, ny); if (np) { np.temp = 140000; np.pack = basePack; } }
      }
    }

    const maxR = Math.min(68, Math.round(44 + power * 18));
    activeShockwaves.push({ cx, cy, r: 3.5, prevR: 2.5, maxR, speed: 2.8, power, isHypernova: formBlackHole });
    spawnNeutronsAround(cx, cy, 32, "fast_neutron");
    spawnParticle(cx, cy, "gamma_ray", 12);
    explodeAt(cx, cy, 18, "plasma,radiation,fire");
    notifyUser(formBlackHole ? "HYPERNOVA -> Black Hole!" : "SUPERNOVA -> Neutron Star!", true);
  }

  function updateShockwavesTick() {
    if (!activeShockwaves.length) return;
    for (let i = activeShockwaves.length - 1; i >= 0; i--) {
      const w = activeShockwaves[i];
      w.prevR = w.r; w.r += w.speed;
      const rMin = Math.max(3, w.prevR - 1.5), rMax = w.r + 1.5;
      const rMin2 = rMin * rMin, rMax2 = rMax * rMax, bound = Math.ceil(rMax);

      for (let dx = -bound; dx <= bound; dx++) {
        for (let dy = -bound; dy <= bound; dy++) {
          const d2 = dx * dx + dy * dy;
          if (d2 < rMin2 || d2 > rMax2) continue;
          const nx = w.cx + dx, ny = w.cy + dy;
          if (!inSafeBounds(nx, ny)) continue;
          const p = pixelMap[nx][ny];
          if (!p) {
            if (Math.random() < 0.05 && w.r < w.maxR * 0.72) {
              const fx = safeCreate(Math.random() < 0.55 ? "plasma" : "fire", nx, ny);
              if (fx) { fx.temp = 25000; const d = Math.sqrt(d2) || 1; fx.vx = (dx / d) * 2.6; fx.vy = (dy / d) * 2.6; fx.ejectaTicks = 20; }
            }
            continue;
          }
          if (p.del || IMMOBILE_SPECIAL.has(p.element)) continue;
          const dist = Math.sqrt(d2) || 1;
          p.temp = Math.min(220000, p.temp + Math.round((36000 * w.power) / Math.max(4, Math.sqrt(dist))));
          if (SUPER_R_TARGETS.has(p.element) && Math.random() < ((p.element === "oxygen" || p.element === "silicon_gas") ? 0.14 : 0.48)) {
            safeChange(p, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]);
          }
          if (!isImmobileElement(p.element)) {
            const kick = Math.min(4.2, (38 * w.power) / Math.max(5, dist));
            p.vx = (p.vx || 0) + (dx / dist) * kick;
            p.vy = (p.vy || 0) + (dy / dist) * kick;
            p.ejectaTicks = 30;
            movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
          }
        }
      }
      if (w.r >= w.maxR) activeShockwaves.splice(i, 1);
    }
  }

  function drawShockwavesAndPackGlow() {
    if (typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;
    if (UPC_CONFIG.showPackGlow && UPC_STATS.maxPack >= 2 && currentPixels?.length) {
      ctx.save();
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del || !p.pack || p.pack < 2) continue;
        const a = Math.min(0.68, 0.12 + Math.log2(p.pack) * 0.16);
        ctx.fillStyle = p.element === "neutronium" ? `rgba(170,245,255,${a.toFixed(2)})` : `rgba(255,248,215,${a.toFixed(2)})`;
        ctx.fillRect(p.x * pixelSize, p.y * pixelSize, pixelSize, pixelSize);
      }
      ctx.restore();
    }
    if (!activeShockwaves.length) return;
    ctx.save();
    for (let i = 0; i < activeShockwaves.length; i++) {
      const w = activeShockwaves[i], frac = 1 - w.r / w.maxR;
      if (frac <= 0) continue;
      ctx.strokeStyle = w.isHypernova ? `rgba(195,130,255,${(frac * 0.85).toFixed(2)})` : `rgba(255,225,150,${(frac * 0.85).toFixed(2)})`;
      ctx.lineWidth = Math.max(2, pixelSize * (1.4 + frac * 2.2));
      ctx.beginPath(); ctx.arc((w.cx + 0.5) * pixelSize, (w.cy + 0.5) * pixelSize, w.r * pixelSize, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function rebuildFields() {
    if (!ensureFieldTables()) return;
    macroMass.fill(0); macroGx.fill(0); macroGy.fill(0); macroPhi.fill(0);
    macroIronPack.fill(0); macroHotIronPack.fill(0);
    macroPole.fill(0); macroMagAbs.fill(0); macroBx.fill(0); macroBy.fill(0); macroMagPot.fill(0);

    let hasStarGravity = false, hasPointWell = false, hasMagnets = false, hasVisualizer = false, peakPack = 1;
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del) continue;
      const e = p.element, pk = p.pack || 1;
      if (pk > peakPack) peakPack = pk;
      if (e === "star_gravity") { hasStarGravity = true; continue; }
      if (e === "field_visualizer") { hasVisualizer = true; continue; }

      const ms = MAGNET_STRENGTH[e];
      if (ms !== undefined && ((e !== "electromagnet_north" && e !== "electromagnet_south") || p.charge > 0)) {
        depositCIC(macroPole, p.x, p.y, ms); depositCIC(macroMagAbs, p.x, p.y, Math.abs(ms)); hasMagnets = true;
      }

      if (e === "gravity_well") { hasPointWell = true; depositCIC(macroMass, p.x, p.y, 48); }
      else if (e === "neutronium" || e === "black_hole_core") { hasPointWell = true; depositCIC(macroMass, p.x, p.y, getPixelGravMass(e, pk)); }
      else if (!isImmobileElement(e)) {
        depositCIC(macroMass, p.x, p.y, getPixelGravMass(e, pk));
        if (IRON_FAMILY.has(e)) {
          const bIdx = Math.min(fieldMh - 1, Math.max(0, Math.round(p.y / FIELD_BLOCK))) * fieldMw + Math.min(fieldMw - 1, Math.max(0, Math.round(p.x / FIELD_BLOCK)));
          macroIronPack[bIdx] += pk;
          if (p.temp > 80000) macroHotIronPack[bIdx] += pk;
        }
      }
    }
    UPC_STATS.maxPack = peakPack;

    const mode = UPC_CONFIG.gravityMethod;
    if (mode === "off") { hasStarGravity = false; hasPointWell = false; macroMass.fill(0); }
    else if (mode === "star") hasStarGravity = true;
    else if (mode === "wells_only") hasStarGravity = false;
    else if (mode === "com") {
      let totalM = 0, sumX = 0, sumY = 0;
      for (let by = 0; by < fieldMh; by++) for (let bx = 0; bx < fieldMw; bx++) {
        const m = macroMass[by * fieldMw + bx];
        if (m > 0) { totalM += m; sumX += bx * m; sumY += by * m; }
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
        if (p.element === "gravity_well") depositCIC(macroMass, p.x, p.y, 48);
        else if (p.element === "neutronium" || p.element === "black_hole_core") depositCIC(macroMass, p.x, p.y, getPixelGravMass(p.element, p.pack || 1));
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
      const sc = UPC_CONFIG.collapseThresholdScale;
      for (let by = 1; by < mh - 1; by++) {
        for (let bx = 1; bx < mw - 1; bx++) {
          const idx = by * mw + bx;
          if (macroIronPack[idx] < 8) continue;
          let ironSum = 0, hotSum = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const ni = (by + dy) * mw + (bx + dx);
            ironSum += macroIronPack[ni]; hotSum += macroHotIronPack[ni];
          }
          if (ironSum >= 30 * sc && hotSum >= 18 * sc && macroPhi[idx] > 75) {
            const isHypernova = hotSum >= 140 * sc && macroPhi[idx] >= 440 * sc;
            triggerSupernova(bx * FIELD_BLOCK, by * FIELD_BLOCK, isHypernova, Math.min(2.0, Math.max(1.05, macroPhi[idx] / 160)));
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
    const steps = Math.min(p.ejectaTicks > 0 ? 4 : 3, Math.max(Math.abs(remX), Math.abs(remY)));
    const pEl = elements[p.element], pDens = (pEl?.density || 1000) * (p.pack || 1), pState = pEl?.state || "solid";

    for (let s = 0; s < steps && !p.del; s++) {
      const sx = Math.sign(remX), sy = Math.sign(remY);
      if (!sx && !sy) break;
      const nx = p.x + sx, ny = p.y + sy;
      if (!inSafeBounds(nx, ny)) { if (sx) p.vx = 0; if (sy) p.vy = 0; p.rx = 0; p.ry = 0; p.freeSteps = 0; break; }
      if (isEmpty(nx, ny)) { movePixel(p, nx, ny); p.freeSteps = Math.min(20, (p.freeSteps || 0) + 1); remX -= sx; remY -= sy; continue; }
      if (sx && sy) {
        if (inSafeBounds(p.x + sx, p.y) && isEmpty(p.x + sx, p.y)) { movePixel(p, p.x + sx, p.y); p.freeSteps = Math.min(20, (p.freeSteps || 0) + 1); remX -= sx; p.vy *= 0.5; continue; }
        if (inSafeBounds(p.x, p.y + sy) && isEmpty(p.x, p.y + sy)) { movePixel(p, p.x, p.y + sy); p.freeSteps = Math.min(20, (p.freeSteps || 0) + 1); remY -= sy; p.vx *= 0.5; continue; }
      }
      const target = pixelMap[nx][ny];
      if (!target || target.del) break;
      const blockedSpd = Math.hypot(p.vx || 0, p.vy || 0);

      // Fast infalling mass accretes onto Neutron Stars -> TOV Black Hole collapse!
      if (target.element === "neutronium" && gravFieldActive && blockedSpd > 0.65 && (p.freeSteps || 0) >= 1) {
        target.pack = +((target.pack || BASE_NS_PACK) + (p.pack || 1) * (0.65 + blockedSpd * 0.45)).toFixed(2);
        target.temp = Math.min(200000, target.temp + 600);
        breakAllBonds(p); deletePixel(p.x, p.y);
        checkDegeneracyCollapse(target, sampleField(macroPhi, target.x, target.y));
        return;
      }

      if (!isImmobileElement(target.element)) {
        const tInfo = elements[target.element], tDens = (tInfo?.density || 1000) * (target.pack || 1), tState = tInfo?.state || "solid";
        if ((tState === "gas" || tState === "liquid") && pDens > tDens * 1.15) {
          safeSwap(p, target); p.vx *= 0.88; p.vy *= 0.88; p.freeSteps = 0; remX -= sx; remY -= sy; continue;
        }
        const tvx = target.vx || 0, tvy = target.vy || 0, relSpd = Math.hypot(p.vx - tvx, p.vy - tvy);
        const impAdd = Math.min(1.6, relSpd * 0.7);
        p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + impAdd);
        target.inwardImpulse = Math.min(4.0, (target.inwardImpulse || 0) + impAdd * 0.85);
        if ((p.freeSteps || 0) >= 2 && relSpd > 1.55) { const h = Math.min(180, Math.round((relSpd - 1.45) * 28)); p.temp += h; target.temp += h; }
        p.freeSteps = 0; target.freeSteps = 0;
        if (pState === "solid" && tState === "solid" && relSpd < 0.9) {
          if (sx) { p.vx = 0; p.rx = 0; } if (sy) { p.vy = 0; p.ry = 0; }
        } else {
          const tot = pDens + tDens, nvx = (pDens * p.vx + tDens * tvx) / tot, nvy = (pDens * p.vy + tDens * tvy) / tot;
          const damp = (pState === "solid" && tState === "solid") ? 0.55 : 0.82;
          p.vx = nvx * damp; p.vy = nvy * damp;
          const cap = target.ejectaTicks > 0 ? MAX_SPEED * 1.6 : MAX_SPEED;
          target.vx = Math.max(-cap, Math.min(cap, tvx + (nvx - tvx) * 1.05));
          target.vy = Math.max(-cap, Math.min(cap, tvy + (nvy - tvy) * 1.05));
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
    if (!gravFieldActive && !magFieldActive && movingPixelsLastTick === 0 && !activeShockwaves.length) { UPC_STATS.movingPixels = 0; return; }

    const doComp = gravFieldActive && ((t & 1) === 0);
    const mergeBudget = { left: 28 };
    let movingNow = 0;

    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del || isImmobileElement(p.element) || VELOCITY_EXEMPT.has(p.element)) continue;

      let ax = 0, ay = 0, gx = 0, gy = 0;
      if (gravFieldActive) {
        gx = sampleField(macroGx, p.x, p.y); gy = sampleField(macroGy, p.x, p.y);
        const radP = p.temp > 38000 ? Math.min(0.75, ((p.temp - 38000) / 115000) * Math.min(1.5, 0.7 + (p.pack || 1) * 0.15)) : 0;
        const gScale = GRAV_ACCEL * (1 - radP);
        ax += gx * gScale; ay += gy * gScale;
      }

      if (magFieldActive) {
        const pole = MAGNET_POLE_MAP[p.element];
        if (pole !== undefined) { ax += pole * sampleField(macroBx, p.x, p.y) * MAG_POLE_ACCEL; ay += pole * sampleField(macroBy, p.x, p.y) * MAG_POLE_ACCEL; }
        else if (isFerromagneticNow(p)) { ax += sampleField(macroGradBx, p.x, p.y) * MAG_FERRO_ACCEL; ay += sampleField(macroGradBy, p.x, p.y) * MAG_FERRO_ACCEL; }
        else if (p.element === "superconductor" && p.temp <= -180) { ax -= sampleField(macroGradBx, p.x, p.y) * MAG_MEISSNER_ACCEL; ay -= sampleField(macroGradBy, p.x, p.y) * MAG_MEISSNER_ACCEL; }
        else if (p.element === "bismuth") { ax -= sampleField(macroGradBx, p.x, p.y) * MAG_DIAMAG_ACCEL; ay -= sampleField(macroGradBy, p.x, p.y) * MAG_DIAMAG_ACCEL; }
        else if (UPC_CONFIG.plasmaConfinement && p.temp >= 6000 && PLASMA_CONFINABLE.has(p.element)) { ax -= sampleField(macroGradBx, p.x, p.y) * MAG_PLASMA_ACCEL; ay -= sampleField(macroGradBy, p.x, p.y) * MAG_PLASMA_ACCEL; }
      }

      const pEl = elements[p.element];
      if ((pEl?.state || "solid") === "solid") {
        const pDens = pEl?.density || 1000;
        if (ax) {
          const sx = Math.sign(ax), nx = p.x + sx, nb = inSafeBounds(nx, p.y) ? pixelMap[nx][p.y] : null;
          if (!inSafeBounds(nx, p.y) || (nb && (isImmobileElement(nb.element) || ((elements[nb.element]?.state || "solid") === "solid" && (elements[nb.element]?.density || 1000) >= pDens * 0.85 && (nb.vx || 0) * sx <= 0.15)))) {
            p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + Math.abs(ax)); ax = 0; if (Math.sign(p.vx || 0) === sx) { p.vx = 0; p.rx = 0; } p.freeSteps = 0;
          }
        }
        if (ay) {
          const sy = Math.sign(ay), ny = p.y + sy, nb = inSafeBounds(p.x, ny) ? pixelMap[p.x][ny] : null;
          if (!inSafeBounds(p.x, ny) || (nb && (isImmobileElement(nb.element) || ((elements[nb.element]?.state || "solid") === "solid" && (elements[nb.element]?.density || 1000) >= pDens * 0.85 && (nb.vy || 0) * sy <= 0.15)))) {
            p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + Math.abs(ay)); ay = 0; if (Math.sign(p.vy || 0) === sy) { p.vy = 0; p.ry = 0; } p.freeSteps = 0;
          }
        }
      }

      if (doComp) {
        const selfM = starModeActive ? getPixelGravMass(p.element, p.pack || 1) : 0;
        applyStateAwareCompression(p, gx, gy, Math.max(0, sampleField(macroPhi, p.x, p.y) - selfM * SELF_PHI_UNIT), mergeBudget);
        if (p.del) continue;
      }

      const prevVx = p.vx || 0, prevVy = p.vy || 0;
      if (!ax && !ay && !prevVx && !prevVy) continue;
      const isEjecta = p.ejectaTicks > 0;
      if (isEjecta) p.ejectaTicks--;
      const drag = isEjecta ? 0.992 : (starModeActive ? UPC_CONFIG.starDrag : 0.94);
      let vx = (prevVx + ax) * drag, vy = (prevVy + ay) * drag;
      const cap = isEjecta ? MAX_SPEED * 1.6 : MAX_SPEED, spd2 = vx * vx + vy * vy;
      if (spd2 > cap * cap) { const sc = cap / Math.sqrt(spd2); vx *= sc; vy *= sc; }
      if (Math.abs(vx) < 0.015) vx = 0; if (Math.abs(vy) < 0.015) vy = 0;
      p.vx = vx; p.vy = vy;
      if (vx || vy) { movingNow++; p.rx = (p.rx || 0) + vx; p.ry = (p.ry || 0) + vy; advancePixelByVelocity(p); }
    }
    movingPixelsLastTick = movingNow; UPC_STATS.movingPixels = movingNow;
    updateShockwavesTick();
  }

  function drawFieldOverlay() {
    if (!visualizerActive || (!gravFieldActive && !magFieldActive) || typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;
    ctx.save(); ctx.lineWidth = Math.max(1, pixelSize * 0.22);
    const stepPx = FIELD_BLOCK * pixelSize;
    for (let by = 0; by < fieldMh - 1; by++) for (let bx = 0; bx < fieldMw - 1; bx++) {
      const idx = by * fieldMw + bx, cx = bx * stepPx, cy = by * stepPx;
      if (magFieldActive) {
        const bLen = Math.hypot(macroBx[idx], macroBy[idx]);
        if (bLen > 0.15) { const dL = Math.min(stepPx * 0.45, Math.log1p(bLen) * stepPx * 0.22); ctx.strokeStyle = "rgba(0,235,255,0.55)"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (macroBx[idx] / bLen) * dL, cy + (macroBy[idx] / bLen) * dL); ctx.stroke(); }
      }
      if (gravFieldActive) {
        const gLen = Math.hypot(macroGx[idx], macroGy[idx]);
        if (gLen > 0.4) { const dL = Math.min(stepPx * 0.45, Math.log1p(gLen) * stepPx * 0.16); ctx.strokeStyle = "rgba(255,196,61,0.50)"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (macroGx[idx] / gLen) * dL, cy + (macroGy[idx] / gLen) * dL); ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 5. NUCLEAR FISSION & IONIZING RADIATION ENGINE
  // ---------------------------------------------------------------------------

  const MODERATOR_PROB = { water: 0.32, ice: 0.28, heavy_water: 0.26, heavy_ice: 0.24, graphite: 0.20, paraffin: 0.30 };
  const REFLECTORS = new Set(["beryllium", "molten_beryllium", "tungsten", "steel"]);
  const POISONS = new Set(["boron", "molten_boron", "cadmium", "molten_cadmium", "hafnium", "molten_hafnium", "xenon_135"]);
  const HIGH_Z_SHIELD = new Set(["lead", "molten_lead", "tungsten", "osmium", "uranium_238", "concrete"]);
  const BETA_SHIELD = new Set(["aluminum", "iron", "steel", "copper", "glass", "lead", "tungsten", "osmium", "concrete", "titanium"]);
  const MAX_SPAWN_PER_TICK = 28, MAX_IONIZING = 180, EXPLODE_COOLDOWN_TICKS = 14;

  let lastPhysicsTick = -1, neutronsThisTick = 0, prevTickNeutrons = 0, spawnedThisTick = 0, ionizingThisTick = 0, lastExplodeTick = -100, loggedNeutronError = false;
  function syncPhysicsTick() {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t !== lastPhysicsTick) { prevTickNeutrons = neutronsThisTick; UPC_STATS.activeNeutrons = neutronsThisTick; neutronsThisTick = 0; spawnedThisTick = 0; ionizingThisTick = 0; lastPhysicsTick = t; }
  }

  const FISSILE_SPECS = {
    uranium_235:          { th: 0.28, fa: 0.025, n: [2, 3], heat: 1500, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    molten_uranium_235:   { th: 0.25, fa: 0.022, n: [2, 3], heat: 1500, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    plutonium_239:        { th: 0.32, fa: 0.085, n: [2, 3], heat: 1750, d: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    molten_plutonium_239: { th: 0.30, fa: 0.075, n: [2, 3], heat: 1750, d: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    uranium_233:          { th: 0.30, fa: 0.045, n: [2, 3], heat: 1450, d: ["barium_141", "krypton_92", "strontium_90"] },
    molten_uranium_233:   { th: 0.27, fa: 0.040, n: [2, 3], heat: 1450, d: ["barium_141", "krypton_92", "strontium_90"] },
    uranium:              { th: 0.12, fa: 0.010, n: [2, 2], heat: 1050, d: ["barium_141", "krypton_92", "xenon_135"] },
    plutonium:            { th: 0.32, fa: 0.085, n: [2, 3], heat: 1750, d: ["barium_141", "xenon_135", "strontium_90"] },
    enriched_uranium:     { th: 0.27, fa: 0.025, n: [2, 3], heat: 1500, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] }
  };

  function spawnParticle(cx, cy, elemName, count = 1) {
    syncPhysicsTick();
    if (!elements[elemName] || ionizingThisTick >= MAX_IONIZING) return;
    const dirs = NON_ZERO_DIRS.slice().sort(() => Math.random() - 0.5);
    for (let i = 0, sp = 0; i < 8 && sp < count && ionizingThisTick < MAX_IONIZING; i++) {
      const np = safeCreate(elemName, cx + dirs[i][0], cy + dirs[i][1]);
      if (np) { np.vx = dirs[i][0]; np.vy = dirs[i][1]; np.life = elemName === "alpha_particle" ? 22 : elemName === "beta_particle" ? 65 : 100; sp++; ionizingThisTick++; }
    }
  }

  function spawnNeutronsAround(cx, cy, count, type = "fast_neutron") {
    syncPhysicsTick();
    if (!elements[type] || prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS || spawnedThisTick >= MAX_SPAWN_PER_TICK) return;
    const dirs = NON_ZERO_DIRS.slice().sort(() => Math.random() - 0.5);
    for (let i = 0, sp = 0; i < 8 && sp < count && prevTickNeutrons + spawnedThisTick < MAX_NEUTRONS && spawnedThisTick < MAX_SPAWN_PER_TICK; i++) {
      for (let dist = 1; dist <= 2; dist++) {
        const np = safeCreate(type, cx + dirs[i][0] * dist, cy + dirs[i][1] * dist);
        if (np) { np.vx = dirs[i][0]; np.vy = dirs[i][1]; np.life = 135; sp++; spawnedThisTick++; break; }
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
    let nearby = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const nx = tx + dx, ny = ty + dy;
      if (!inSafeBounds(nx, ny)) continue;
      const p = pixelMap[nx][ny];
      if (p && !p.del) { p.temp += Math.round(heatAmt * 0.16); if (FISSILE_SPECS[p.element]) nearby++; }
    }
    if (neutronPixel && !neutronPixel.del && inSafeBounds(neutronPixel.x, neutronPixel.y) && pixelMap[neutronPixel.x][neutronPixel.y] === neutronPixel) deletePixel(neutronPixel.x, neutronPixel.y);
    spawnNeutronsAround(tx, ty, spec.n[0] + (Math.random() < 0.4 ? spec.n[1] - spec.n[0] : 0), "fast_neutron");
    if (Math.random() < 0.25) spawnParticle(tx, ty, "gamma_ray", 1);
    if (targetPixel.temp > 7500 && nearby >= 12 && lastPhysicsTick - lastExplodeTick >= EXPLODE_COOLDOWN_TICKS) {
      lastExplodeTick = lastPhysicsTick; explodeAt(tx, ty, 9, "plasma,fire,radiation,fallout");
    }
  }

  function ionizingParticleTick(pixel, kind) {
    if (!pixel || pixel.del) return;
    syncPhysicsTick(); ionizingThisTick++;
    if (ionizingThisTick > MAX_IONIZING * 1.4) { deletePixel(pixel.x, pixel.y); return; }
    if (!pixel.vx && !pixel.vy) { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; }
    if (pixel.life === undefined) pixel.life = kind === "alpha" ? 22 : kind === "beta" ? 65 : 100;
    if (--pixel.life <= 0) { if (kind === "alpha" && Math.random() < 0.35 && elements.helium) safeChange(pixel, "helium"); else deletePixel(pixel.x, pixel.y); return; }
    for (let s = 0, steps = kind === "gamma" ? 2 : 1; s < steps && !pixel.del; s++) {
      const nx = pixel.x + pixel.vx, ny = pixel.y + pixel.vy;
      if (!inSafeBounds(nx, ny)) { deletePixel(pixel.x, pixel.y); return; }
      if (isEmpty(nx, ny)) { movePixel(pixel, nx, ny); continue; }
      const target = pixelMap[nx][ny];
      if (!target || target === pixel || target.del) continue;
      const tElem = target.element;
      if (kind === "alpha") {
        if (tElem === "beryllium" || tElem === "molten_beryllium") { spawnNeutronsAround(target.x, target.y, 1, "fast_neutron"); target.temp += 60; deletePixel(pixel.x, pixel.y); return; }
        if (elements[tElem]?.state === "gas") { safeSwap(pixel, target); target.temp += 4; }
        else { target.temp += 35; if (Math.random() < 0.25 && elements.helium) safeChange(pixel, "helium"); else deletePixel(pixel.x, pixel.y); return; }
      } else if (kind === "beta") {
        if (BETA_SHIELD.has(tElem)) { target.temp += 18; deletePixel(pixel.x, pixel.y); return; }
        target.temp += 5; safeSwap(pixel, target);
      } else {
        if (HIGH_Z_SHIELD.has(tElem) && Math.random() < 0.55) { target.temp += 28; deletePixel(pixel.x, pixel.y); return; }
        target.temp += 8; safeSwap(pixel, target);
      }
    }
  }

  function neutronTick(pixel, isFast) {
    try {
      if (!pixel || pixel.del) return;
      syncPhysicsTick(); neutronsThisTick++;
      if (neutronsThisTick > MAX_NEUTRONS * 1.25) { deletePixel(pixel.x, pixel.y); return; }
      if (!pixel.vx && !pixel.vy) { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; }
      if (pixel.life === undefined) pixel.life = 135;
      if (--pixel.life <= 0) { safeChangeAny(pixel, ["proton", "hydrogen"]); return; }
      if (!isFast && Math.random() > 0.55) return;
      const steps = isFast ? (Math.random() < 0.35 ? 2 : 1) : 1;

      for (let s = 0; s < steps && !pixel.del; s++) {
        const nx = pixel.x + pixel.vx, ny = pixel.y + pixel.vy;
        if (!inSafeBounds(nx, ny)) { deletePixel(pixel.x, pixel.y); return; }
        if (isEmpty(nx, ny)) { movePixel(pixel, nx, ny); continue; }
        const target = pixelMap[nx][ny];
        if (!target || target === pixel || target.del) continue;
        const tElem = target.element;

        if (FISSILE_SPECS[tElem]) {
          const spec = FISSILE_SPECS[tElem];
          let prob = (isFast ? spec.fa : spec.th) * UPC_CONFIG.fissionRate;
          if (!isFast && target.temp > 1200) prob *= Math.max(0.60, 1 - (target.temp - 1200) / 10000);
          if (Math.random() < prob) { triggerFission(target, spec, pixel); return; }
          if (Math.random() < 0.55) safeSwap(pixel, target); else { pixel.vx = -pixel.vx; pixel.vy = -pixel.vy; }
          return;
        }
        if (isFast && target.temp > 75000 && SUPER_R_TARGETS.has(tElem) && Math.random() < 0.2) { safeChange(target, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]); deletePixel(pixel.x, pixel.y); return; }
        if ((tElem === "uranium_238" || tElem === "molten_uranium_238") && Math.random() < ((isFast ? 0.05 : 0.16) + (target.temp > 800 ? 0.04 : 0)) * UPC_CONFIG.fissionRate) { safeChange(target, "neptunium_239"); target.temp += 110; deletePixel(pixel.x, pixel.y); return; }
        if ((tElem === "thorium_232" || tElem === "molten_thorium_232" || tElem === "thorium") && Math.random() < (isFast ? 0.04 : 0.18) * UPC_CONFIG.fissionRate) { safeChange(target, "protactinium_233"); target.temp += 100; deletePixel(pixel.x, pixel.y); return; }
        if ((tElem === "lithium_6" || tElem === "molten_lithium_6") && Math.random() < 0.3) { safeChange(target, "tritium"); target.temp += 650; safeChange(pixel, "helium"); return; }
        if ((tElem === "cobalt" || tElem === "molten_cobalt") && Math.random() < 0.14) { safeChange(target, "cobalt_60"); target.temp += 90; deletePixel(pixel.x, pixel.y); return; }
        if (tElem === "nitrogen" && !isFast && Math.random() < 0.06) { safeChange(target, "carbon_14"); safeChangeAny(pixel, ["proton", "hydrogen"]); return; }
        if (POISONS.has(tElem) && !isFast && Math.random() < (tElem === "xenon_135" ? 0.90 : 0.72)) {
          target.temp += 60;
          if (tElem === "boron" && Math.random() < 0.12) safeChange(target, "lithium_7");
          else if (tElem === "xenon_135") safeChange(target, "xenon_136");
          deletePixel(pixel.x, pixel.y); return;
        }
        if (MODERATOR_PROB[tElem] !== undefined) {
          target.temp += isFast ? 24 : 3;
          if (isFast) {
            if (tElem === "water" && Math.random() < 0.025) { safeChange(target, "heavy_water"); deletePixel(pixel.x, pixel.y); return; }
            if (Math.random() < MODERATOR_PROB[tElem]) { safeChange(pixel, "thermal_neutron"); const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; return; }
          }
          safeSwap(pixel, target); return;
        }
        if (REFLECTORS.has(tElem)) {
          pixel.vx = Math.max(-1, Math.min(1, -pixel.vx + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0)));
          pixel.vy = Math.max(-1, Math.min(1, -pixel.vy + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0)));
          if (!pixel.vx && !pixel.vy) { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; }
          if (isFast && !pixel.beMultiplied && (tElem === "beryllium" || tElem === "molten_beryllium") && Math.random() < 0.05) { pixel.beMultiplied = true; spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron"); }
          return;
        }
        if (HIGH_Z_SHIELD.has(tElem)) { target.temp += 12; if (Math.random() < 0.42) { deletePixel(pixel.x, pixel.y); return; } pixel.vx = -pixel.vx; pixel.vy = -pixel.vy; return; }
        const tState = elements[tElem]?.state;
        if (tState === "gas" || tElem === "fire" || tElem === "plasma" || RADIOLYSIS_AGENTS.has(tElem)) safeSwap(pixel, target);
        else { const d = randomDir(); pixel.vx = d[0]; pixel.vy = d[1]; return; }
      }
    } catch (err) { if (!loggedNeutronError) { loggedNeutronError = true; console.error("[UPC] neutronTick:", err); } }
  }

  // ---------------------------------------------------------------------------
  // 6. INTERACTIVE PHYSICS TOOLS
  // ---------------------------------------------------------------------------

  registerOrEnhance("orbit_launch", {
    color: ["#ffcf40", "#ffe082"], category: "tools", desc: "Gives brushed matter circular orbital velocity perpendicular to local gravity.",
    tool: (p) => {
      if (!p || p.del || isImmobileElement(p.element) || VELOCITY_EXEMPT.has(p.element)) return;
      if (!gravFieldActive) rebuildFields();
      if (!gravFieldActive) return;
      const gx = sampleField(macroGx, p.x, p.y), gy = sampleField(macroGy, p.x, p.y), gMag = Math.hypot(gx, gy);
      if (gMag < 0.01) return;
      const selfM = starModeActive ? getPixelGravMass(p.element, p.pack || 1) : 0;
      const vCirc = Math.min(MAX_SPEED * 0.92, Math.sqrt(4 * Math.max(0, sampleField(macroPhi, p.x, p.y) - selfM * SELF_PHI_UNIT) * GRAV_ACCEL));
      p.vx = (-gy / gMag) * vCirc; p.vy = (gx / gMag) * vCirc; movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }
  });
  registerOrEnhance("kinetic_launch", { color: ["#ff6e40", "#ff9e80"], category: "tools", desc: "Launches brushed matter right & slightly upward.", tool: (p) => { if (p && !p.del && !isImmobileElement(p.element) && !VELOCITY_EXEMPT.has(p.element)) { p.vx = MAX_SPEED * 0.88; p.vy = -0.35; movingPixelsLastTick = Math.max(movingPixelsLastTick, 1); } } });
  registerOrEnhance("vel_stop", { color: ["#78909c", "#b0bec5"], category: "tools", desc: "Cancels all velocity on brushed pixels.", tool: (p) => { if (p && !p.del) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; } } });
  registerOrEnhance("compress_tool", {
    color: ["#ab47bc", "#ce93d8"], category: "tools", desc: "Packs adjacent same-element voxels together (or presses hot graphite -> diamond / ice -> water).",
    tool: (p) => {
      if (!p || p.del) return;
      p.pressure = (p.pressure || 0) + 400;
      const st = elements[p.element]?.state;
      if (st === "gas") { const nb = findAdjacentElement(p, p.element); if (nb && mergeVoxelInto(p, nb, true)) checkDegeneracyCollapse(p, Math.max(110, sampleField(macroPhi, p.x, p.y))); else p.temp += 1200; }
      else if (st === "liquid") p.temp += 25;
      else { p.stress = Math.min(1600, (p.stress || 0) + 250); if (p.element === "graphite" && p.temp >= 1200 && elements.diamond) safeChange(p, "diamond"); else if (p.element === "ice" && elements.water) safeChange(p, "water"); }
    }
  });
  registerOrEnhance("bond_tool", { color: ["#69f0ae", "#b9f6ca"], category: "tools", desc: "Links adjacent pixels with persistent chemical bonds.", tool: (p) => { if (!p || p.del || getBondCount(p) >= 3) return; for (let i = 0; i < 8; i++) { const nx = p.x + NON_ZERO_DIRS[i][0], ny = p.y + NON_ZERO_DIRS[i][1]; if (inSafeBounds(nx, ny) && pixelMap[nx][ny] && !pixelMap[nx][ny].del && !hasBondBetween(p, pixelMap[nx][ny]) && createBond(p, pixelMap[nx][ny], "catalyst", 2800)) return; } } });
  registerOrEnhance("cleave_tool", { color: ["#ff5252", "#ff8a80"], category: "tools", desc: "Snaps all chemical bonds on brushed pixels.", tool: (p) => { if (p && !p.del) breakAllBonds(p); } });
  registerOrEnhance("magnetize_tool", { color: ["#e53935", "#1e88e5"], category: "tools", desc: "Magnetizes iron/steel/neodymium or flips N <-> S poles.", tool: (p) => { if (!p || p.del) return; const m = { iron: "magnet_north", steel: "magnet_north", iron_filings: "magnet_bead_n", neodymium: "neodymium_north", magnet_north: "magnet_south", magnet_south: "magnet_north", neodymium_north: "neodymium_south", neodymium_south: "neodymium_north", magnet_bead_n: "magnet_bead_s", magnet_bead_s: "magnet_bead_n" }; if (m[p.element]) safeChange(p, m[p.element]); } });
  registerOrEnhance("neutron_pulse", { color: ["#ff6d00", "#ffd180"], category: "tools", desc: "Emits fast neutrons around brushed pixels.", tool: (p) => { if (p && !p.del && Math.random() < 0.25) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); } });

  let lastInspectTime = 0;
  registerOrEnhance("inspect_tool", {
    color: ["#26c6da", "#80deea"], category: "tools", desc: "Quietly displays state, temp, pack, pressure, velocity, g, B, and active bonds.",
    tool: (p) => {
      if (!p || p.del) return;
      const now = Date.now();
      if (now - lastInspectTime < 180) return;
      lastInspectTime = now;
      const g = gravFieldActive ? Math.hypot(sampleField(macroGx, p.x, p.y), sampleField(macroGy, p.x, p.y)).toFixed(2) : "0";
      const b = magFieldActive ? sampleField(macroBmag, p.x, p.y).toFixed(2) : "0";
      const pb = getBonds(p), bl = pb?.length ? pb.map(x => `${x.target.element}(${x.type})`).join(", ") : "none";
      notifyUser(`${p.element}[${elements[p.element]?.state || "?"}] | ${Math.round(p.temp)}C | pack=${(p.pack || 1).toFixed(1)}x | P=${p.pressure || 0} | v=(${(p.vx || 0).toFixed(2)},${(p.vy || 0).toFixed(2)}) | g=${g} | B=${b} | bonds: ${bl}`, true);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. ASTROPHYSICS, BONDING, MAGNETS, RADIATION & SPECIAL ELEMENTS
  // ---------------------------------------------------------------------------

  registerOrEnhance("star_gravity", { color: ["#1a0b2e", "#31135e", "#4d1f91"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 99999, hardness: 1, desc: "Enables global multi-body CIC Gravity-Tile self-gravity." });
  registerOrEnhance("gravity_well", { color: ["#120024", "#2a0052", "#5900a6"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 99999, hardness: 1, desc: "Localized planetary/stellar gravity anchor." });
  registerOrEnhance("field_visualizer", { color: ["#00e5ff", "#ffd740"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 1000, desc: "Renders live Magnetic (cyan) and Gravity (gold) field vectors." });
  registerOrEnhance("neutronium", { color: ["#d9f7ff", "#ffffff", "#9ce5ff"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 999999, hardness: 1, conduct: 1, desc: "Degenerate neutron-star core. Accretes fast matter until crossing the TOV limit -> Black Hole.", tick: (p) => { if (Math.random() < 0.002) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } });
  registerOrEnhance("black_hole_core", {
    color: ["#050008", "#0d0014", "#1a0029"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 9999999, hardness: 1, desc: "Event-horizon singularity. Devours matter and emits gamma jets.",
    tick: (p) => {
      for (let i = 0; i < 8; i++) {
        const nx = p.x + NON_ZERO_DIRS[i][0], ny = p.y + NON_ZERO_DIRS[i][1];
        if (!inSafeBounds(nx, ny)) continue;
        const v = pixelMap[nx][ny];
        if (!v || v.del || IMMOBILE_SPECIAL.has(v.element)) continue;
        p.pack = Math.min(250, +((p.pack || BASE_BH_PACK) + (v.pack || 1) * 0.5).toFixed(2));
        breakAllBonds(v); deletePixel(nx, ny);
        if (Math.random() < 0.18) spawnParticle(p.x, p.y, "gamma_ray", 1);
      }
      doDefaults(p);
    }
  });
  registerOrEnhance("bond_catalyst", {
    color: ["#6bff7a", "#9cff9e", "#3de050"], behavior: behaviors.POWDER, category: "chemistry", state: "solid", density: 10, desc: "Links two adjacent elements with a persistent chemical bond.",
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
  registerOrEnhance("bond_breaker", { color: ["#ff477e", "#ff7096", "#e0245e"], behavior: behaviors.GAS, category: "chemistry", state: "gas", density: 0.5, desc: "Cleaves chemical bonds on contact.", tick: (p) => { if (p.life === undefined) p.life = 25; if (--p.life <= 0) { deletePixel(p.x, p.y); return; } doDefaults(p); } });

  registerOrEnhance("magnet_north", { color: ["#d92626", "#e83838", "#bf1d1d"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.5, hardness: 0.8, tempHigh: 770, stateHigh: "iron", desc: "North pole (Curie: 770 C)." });
  registerOrEnhance("magnet_south", { color: ["#1e5ad9", "#2e6df0", "#1749b5"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.5, hardness: 0.8, tempHigh: 770, stateHigh: "iron", desc: "South pole (Curie: 770 C)." });
  registerOrEnhance("neodymium_north", { color: ["#ff1744", "#ff4569", "#d5002f"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.45, hardness: 0.75, tempHigh: 310, stateHigh: "neodymium", desc: "Neodymium North pole (Curie: 310 C)." });
  registerOrEnhance("neodymium_south", { color: ["#0044ff", "#2962ff", "#0032bd"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.45, hardness: 0.75, tempHigh: 310, stateHigh: "neodymium", desc: "Neodymium South pole (Curie: 310 C)." });
  registerOrEnhance("electromagnet_north", { color: ["#b85d38", "#cc6b43", "#9e4d2d"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 8400, conduct: 1, hardness: 0.8, desc: "Switchable North Electromagnet." });
  registerOrEnhance("electromagnet_south", { color: ["#486b9e", "#587eb5", "#3b5985"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 8400, conduct: 1, hardness: 0.8, desc: "Switchable South Electromagnet." });
  registerOrEnhance("magnet_bead_n", { color: ["#ff5252", "#ff7575"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7400, hardness: 0.75, tempHigh: 770, stateHigh: "iron_filings", desc: "Movable North magnetic bead." });
  registerOrEnhance("magnet_bead_s", { color: ["#448aff", "#69a1ff"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7400, hardness: 0.75, tempHigh: 770, stateHigh: "iron_filings", desc: "Movable South magnetic bead." });
  registerOrEnhance("iron_filings", { color: ["#525559", "#64686e", "#43464a"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7870, conduct: 0.7, hardness: 0.72, tempHigh: 1538, stateHigh: "molten_iron", desc: "Ferromagnetic iron powder (Curie: 770 C)." });
  registerOrEnhance("superconductor", { color: ["#242933", "#303745", "#1c2029"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 6300, conduct: 1, hardness: 0.7, desc: "YBCO Superconductor (Meissner levitation below -180 C)." });

  registerOrEnhance("fast_neutron", { color: ["#ff4444", "#ff7744", "#ffaa44"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, temp: 20, desc: "Fast ~2 MeV neutron.", tick: (p) => neutronTick(p, true) });
  registerOrEnhance("thermal_neutron", { color: ["#44ccff", "#66eeff", "#99f5ff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, temp: 20, desc: "Slow thermal neutron.", tick: (p) => neutronTick(p, false) });
  registerOrEnhance("alpha_particle", { color: ["#ffea00", "#ffff72"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Alpha particle (He-4 nucleus).", tick: (p) => ionizingParticleTick(p, "alpha") });
  registerOrEnhance("beta_particle", { color: ["#00e5ff", "#84ffff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Beta electron.", tick: (p) => ionizingParticleTick(p, "beta") });
  registerOrEnhance("gamma_ray", { color: ["#ea80fc", "#ffffff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Gamma photon.", tick: (p) => ionizingParticleTick(p, "gamma") });
  registerOrEnhance("heavy_water", { color: ["#1e5ec4", "#246ad6", "#1a52ab"], behavior: behaviors.LIQUID, category: "nuclear", state: "liquid", density: 1107, tempHigh: 101.4, stateHigh: "heavy_steam", tempLow: 3.8, stateLow: "heavy_ice", conduct: 0.02, desc: "Deuterium Oxide (D2O) moderator." });
  registerOrEnhance("heavy_ice", { color: ["#a8d0f5", "#b8daf8"], behavior: behaviors.WALL, category: "states", state: "solid", hidden: true, density: 1017, temp: 0, tempHigh: 3.8, stateHigh: "heavy_water" });
  registerOrEnhance("heavy_steam", { color: ["#c7dbf0", "#d7e6f5"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 0.66, temp: 110, tempLow: 101.4, stateLow: "heavy_water", tick: (p) => { if (p.temp >= 3200 && Math.random() < 0.07) { safeChange(p, Math.random() < 0.66 ? "deuterium" : "oxygen"); return; } doDefaults(p); } });
  registerOrEnhance("carbon_vapor", {
    color: ["#54545c", "#666670", "#45454d"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 0.52, temp: 3700, tempLow: 3642, stateLow: "graphite", desc: "Carbon-12 gas (>3,642 C).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0) {
        if (p.temp >= 75000 && Math.random() < 0.014 * fr) { const he = findAdjacentElement(p, "helium"); if (he) { fusePair(p, he, "oxygen", "gamma_ray", 3600); return; } }
        if (p.temp >= 82000 && Math.random() < 0.012 * fr) { const o = findAdjacentElement(p, "carbon_vapor"); if (o) { fusePair(p, o, Math.random() < 0.55 ? "neon" : "magnesium_gas", "gamma_ray", 3200); return; } }
      }
      doDefaults(p);
    },
    reactions: { oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.12 } }
  });
  registerOrEnhance("graphite", {
    _override: true, color: ["#2b2b2e", "#36363a", "#232326"], behavior: behaviors.WALL, category: "nuclear", state: "solid", density: 2260, conduct: 0.85, hardness: 0.65, tempHigh: 3642, stateHigh: "carbon_vapor", desc: "Carbon moderator; smelts sand -> silicon & rust -> iron; presses to diamond.",
    reactions: { oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.08 }, sand: { elem1: "carbon_dioxide", elem2: "molten_silicon", tempMin: 1900, tempMax: 3500, chance: 0.12 }, rust: { elem1: "carbon_dioxide", elem2: "molten_iron", tempMin: 1100, tempMax: 3200, chance: 0.14 } }
  });

  // ---------------------------------------------------------------------------
  // 8. FULL GASES, ISOTOPES & SOLID/MOLTEN/GAS ELEMENT CHAINS
  // ---------------------------------------------------------------------------

  const SILICON_STATES = new Set(["silicon", "molten_silicon", "silicon_gas"]);

  defineFullGas({
    id: "deuterium", color: ["#6ea8ff", "#88bbff"], liquidColor: ["#3c7de0", "#4f8ef0"], solidColor: ["#a6cbff", "#c2dcff"], category: "isotopes", boilTemp: -249.5, meltTemp: -254.4, density: 0.18, desc: "Hydrogen-2. Fuses with T (10k C), D (25k C), or He-3 (40k C).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0) {
        if (p.temp >= 10000 && Math.random() < 0.06 * fr) { const t = findAdjacentElement(p, "tritium"); if (t) { fusePair(p, t, "helium", "fast_neutron", 6500); return; } }
        if (p.temp >= 25000 && Math.random() < 0.025 * fr) { const o = findAdjacentElement(p, "deuterium"); if (o) { fusePair(p, o, Math.random() < 0.5 ? "tritium" : "helium_3", Math.random() < 0.5 ? "proton" : "fast_neutron", 3200); return; } }
        if (p.temp >= 40000 && Math.random() < 0.035 * fr) { const h = findAdjacentElement(p, "helium_3"); if (h) { fusePair(p, h, "helium", "proton", 7500); return; } }
      }
      doDefaults(p);
    },
    reactions: { oxygen: { elem1: "heavy_steam", elem2: "fire", tempMin: 560, tempMax: 3000, chance: 0.35 } }
  });
  defineFullGas({ id: "tritium", color: ["#5cffb0", "#82ffc4"], liquidColor: ["#28d483", "#3ee093"], solidColor: ["#9effd0", "#c4ffe2"], category: "isotopes", boilTemp: -248.1, meltTemp: -252.5, density: 0.27, desc: "Hydrogen-3 -> He-3.", tick: (p) => { if (Math.random() < 0.00005) { safeChange(p, "helium_3"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 5; return; } doDefaults(p); } });
  defineFullGas({ id: "helium_3", color: ["#ffe0b3", "#ffd18c"], liquidColor: ["#f0b86e", "#e6a855"], solidColor: ["#fff0d9", "#ffe6bf"], category: "isotopes", boilTemp: -269.9, meltTemp: -272.2, density: 0.13, desc: "Helium-3 aneutronic fuel.", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 45000 && Math.random() < 0.022 * fr) { const o = findAdjacentElement(p, "helium_3"); if (o) { fusePair(p, o, "helium", "proton", 5500); return; } } doDefaults(p); } });
  defineFullGas({ id: "neon", color: ["#ff9678", "#ffab91"], liquidColor: ["#ff7043", "#ff8a65"], solidColor: ["#ffccbc", "#ffd8cc"], category: "gases", boilTemp: -246.1, meltTemp: -248.6, density: 0.90, conduct: 0.4, desc: "Neon; fuses with He (88k C -> Mg).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 88000 && Math.random() < 0.014 * fr) { const he = findAdjacentElement(p, "helium"); if (he) { fusePair(p, he, "magnesium_gas", "gamma_ray", 3000); return; } } doDefaults(p); } });
  defineFullGas({ id: "argon", color: ["#c7b8ff", "#d6ccff"], liquidColor: ["#9b87f5", "#ac99ff"], solidColor: ["#e6e0ff", "#f0ecff"], category: "gases", boilTemp: -185.8, meltTemp: -189.3, density: 1.78, desc: "Inert shielding gas." });
  defineFullGas({ id: "radon", color: ["#b8e0c8", "#ccebd8"], liquidColor: ["#8ac2a0", "#9cd4b2"], solidColor: ["#ffaa55", "#ff8844"], category: "isotopes", boilTemp: -61.7, meltTemp: -71.0, density: 9.73, desc: "Radioactive noble gas -> Po-210.", tick: (p) => { if (Math.random() < 0.00018) { safeChange(p, "polonium_210"); spawnParticle(p.x, p.y, "alpha_particle", 1); p.temp += 15; return; } doDefaults(p); } });
  defineFullGas({ id: "xenon_135", color: ["#9a78e3", "#b091f2"], liquidColor: ["#6c47bd", "#7d55d1"], solidColor: ["#c6b3f5", "#d8c9fa"], category: "isotopes", boilTemp: -108.1, meltTemp: -111.8, density: 5.89, desc: "Reactor poison -> Cs-135.", tick: (p) => { if (Math.random() < 0.0004) { safeChange(p, "cesium_135"); spawnParticle(p.x, p.y, "beta_particle", 1); return; } doDefaults(p); } });
  defineFullGas({ id: "xenon_136", color: ["#7c6fa8", "#9183bd"], liquidColor: ["#5a4d82", "#695a94"], solidColor: ["#b5abdb", "#c8c0e6"], category: "isotopes", boilTemp: -108.1, meltTemp: -111.8, density: 5.93, desc: "Stable Xenon-136." });
  defineFullGas({ id: "krypton_92", color: ["#b8d4e8", "#cfe5f5"], liquidColor: ["#80a8c7", "#92bad9"], solidColor: ["#dcebf7", "#ebf4fc"], category: "isotopes", boilTemp: -153.4, meltTemp: -157.4, density: 3.75, desc: "Delayed-neutron fission gas -> Sr-90.", tick: (p) => { p.temp += 0.08; if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.0006) spawnNeutronsAround(p.x, p.y, 1, "thermal_neutron"); if (Math.random() < 0.0012) { safeChange(p, "strontium_90"); return; } doDefaults(p); } });

  [
    { id: "carbon_14", color: ["#303835", "#3d4743"], moltenColor: ["#7a8f87", "#8ea69d"], gasColor: ["#5c6b65", "#6d7d77"], category: "isotopes", meltTemp: 3550, boilTemp: 4027, density: 2260, conduct: 0.7, behavior: behaviors.POWDER, desc: "C-14 -> N-14.", tick: (p) => { if (Math.random() < 0.00004) { safeChange(p, "nitrogen"); spawnParticle(p.x, p.y, "beta_particle", 1); return; } doDefaults(p); } },
    { id: "magnesium", color: ["#d4d9de", "#e2e6eb", "#c5cbd1"], moltenColor: ["#f0e8d5", "#fff8e8"], gasColor: ["#e8ecf0", "#f5f7fa"], category: "metals", meltTemp: 650, boilTemp: 1091, density: 1738, conduct: 0.78, hardness: 0.5, tickAllStates: true, desc: "Fuses with He (92k C -> Si).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 92000 && Math.random() < 0.014 * fr) { const he = findAdjacentElement(p, "helium"); if (he) { fusePair(p, he, "silicon_gas", "gamma_ray", 3000); return; } } doDefaults(p); }, reactions: { oxygen: { elem1: "ash", elem2: "fire", tempMin: 470, tempMax: 3200, chance: 0.25, func: p1 => { p1.temp += 1400; } }, steam: { elem1: "ash", elem2: "hydrogen", tempMin: 300, chance: 0.2, func: p1 => { p1.temp += 700; } } } },
    { id: "silicon", color: ["#4b525c", "#58606b", "#3f464f"], moltenColor: ["#e8a86b", "#f2b97e"], gasColor: ["#8a96a6", "#9ca8b8"], category: "solids", meltTemp: 1414, boilTemp: 3265, density: 2329, conduct: 0.35, hardness: 0.82, tickAllStates: true, desc: "Si-28; fuses past 115k C -> Ni-56 -> Fe.", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 115000 && Math.random() < 0.015 * fr) { const pt = findAdjacentElement(p, "helium") || findAdjacentElement(p, SILICON_STATES); if (pt) { fusePair(p, pt, "nickel_56_gas", "gamma_ray", 2200); return; } } doDefaults(p); }, reactions: { oxygen: { elem1: "sand", elem2: "fire", tempMin: 900, tempMax: 2500, chance: 0.08 } } },
    { id: "nickel_56", color: ["#9cb5a8", "#adc7b9"], moltenColor: ["#ffbe76", "#ffd39b"], gasColor: ["#c7e3d4", "#daf2e5"], category: "isotopes", meltTemp: 1455, boilTemp: 2913, density: 8908, conduct: 0.7, tickAllStates: true, desc: "Ni-56 -> Co-56 -> Fe-56.", tick: (p) => { p.temp += 0.2; if (Math.random() < 0.0022) { safeChange(p, p.element === "nickel_56_gas" ? "cobalt_56_gas" : p.element === "molten_nickel_56" ? "molten_cobalt_56" : "cobalt_56"); p.temp += 120; return; } doDefaults(p); } },
    { id: "cobalt_56", color: ["#7295c4", "#86a8d6"], moltenColor: ["#ffa366", "#ffb885"], gasColor: ["#a4bfe3", "#b8cff0"], category: "isotopes", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.7, tickAllStates: true, desc: "Co-56 -> Iron-56.", tick: (p) => { p.temp += 0.14; if (Math.random() < 0.0018) { if (p.temp >= 2862) safeChangeAny(p, ["iron_gas", "molten_iron", "iron"]); else if (p.temp >= 1538) safeChangeAny(p, ["molten_iron", "iron"]); else safeChange(p, "iron"); p.temp += 90; return; } doDefaults(p); } },
    { id: "uranium_235", color: ["#4b7843", "#578c4e", "#3f6938"], moltenColor: ["#9be05a", "#b7f06e"], gasColor: ["#88b878", "#a2cc95"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 18950, conduct: 0.45, desc: "Fissile U-235.", tick: (p) => { if (Math.random() < 0.00005) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "uranium_238", color: ["#3b4d3b", "#455945", "#324232"], moltenColor: ["#7a9c59", "#8eb06a"], gasColor: ["#6b7d6b", "#7c8f7c"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 19100, conduct: 0.45, desc: "Fertile U-238 -> Pu-239." },
    { id: "neptunium_239", color: ["#5e6e7d", "#6e8091"], moltenColor: ["#b58d52", "#cfa363"], gasColor: ["#8e9eab", "#a3b3c2"], category: "isotopes", meltTemp: 644, boilTemp: 3902, density: 20450, conduct: 0.35, desc: "Np-239 -> Pu-239.", tick: (p) => { p.temp += 0.05; if (Math.random() < 0.0008) { safeChange(p, "plutonium_239"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 45; return; } doDefaults(p); } },
    { id: "plutonium_239", color: ["#6b756b", "#7d8a7d", "#5c665c"], moltenColor: ["#e68a45", "#f5a056"], gasColor: ["#9ca89c", "#b0bdb0"], category: "nuclear", meltTemp: 640, boilTemp: 3228, density: 19816, conduct: 0.25, desc: "Fissile Pu-239.", tick: (p) => { p.temp += 0.03; if (Math.random() < 0.00014) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "thorium_232", color: ["#63605c", "#75726d", "#575450"], moltenColor: ["#d98a4e", "#eb9e60"], gasColor: ["#8f8b85", "#a39f98"], category: "nuclear", meltTemp: 1750, boilTemp: 4788, density: 11724, conduct: 0.5, desc: "Fertile Th-232 -> U-233." },
    { id: "protactinium_233", color: ["#7a7380", "#8c8494"], moltenColor: ["#c78b63", "#db9e74"], gasColor: ["#a199a8", "#b3abc0"], category: "isotopes", meltTemp: 1568, boilTemp: 4027, density: 15370, conduct: 0.4, desc: "Pa-233 -> U-233.", tick: (p) => { p.temp += 0.04; if (Math.random() < 0.0006) { safeChange(p, "uranium_233"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 35; return; } doDefaults(p); } },
    { id: "uranium_233", color: ["#4d8066", "#5a9476", "#427058"], moltenColor: ["#8be0a4", "#a3f0ba"], gasColor: ["#84b89c", "#9accb1"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 18900, conduct: 0.45, desc: "Fissile U-233." },
    { id: "californium_252", color: ["#a8b099", "#bcc4ab"], moltenColor: ["#ffad66", "#ffc285"], gasColor: ["#d4dbc5", "#e4ebd5"], category: "nuclear", meltTemp: 900, boilTemp: 1470, density: 15100, conduct: 0.4, desc: "Spontaneous neutron source.", tick: (p) => { p.temp += 0.2; if (Math.random() < 0.008) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "americium_241", color: ["#c2c7cc", "#d3d8de"], moltenColor: ["#f0b07a", "#ffc48f"], gasColor: ["#dee3e8", "#eef2f7"], category: "isotopes", meltTemp: 1176, boilTemp: 2607, density: 13670, conduct: 0.45, desc: "Alpha emitter.", tick: (p) => { p.temp += 0.08; if (Math.random() < 0.006) spawnParticle(p.x, p.y, "alpha_particle", 1); doDefaults(p); } },
    { id: "radium_226", color: ["#80ff95", "#a3ffb3", "#64e87b"], moltenColor: ["#b8ffc4", "#d4ffdc"], gasColor: ["#a8e6b2", "#c2f2ca"], category: "isotopes", meltTemp: 700, boilTemp: 1737, density: 5500, conduct: 0.5, desc: "Ra-226 -> Radon -> Po-210 -> Lead.", tick: (p) => { p.temp += 0.08; if (Math.random() < 0.004) spawnParticle(p.x, p.y, "alpha_particle", 1); if (Math.random() < 0.00015) { safeChange(p, "radon"); return; } doDefaults(p); } },
    { id: "polonium_210", color: ["#8c9e99", "#9eb0ab"], moltenColor: ["#b5f5d8", "#ccffe8"], gasColor: ["#a8bfb9", "#bcd4ce"], category: "isotopes", meltTemp: 254, boilTemp: 962, density: 9196, conduct: 0.5, desc: "Po-210 alpha emitter -> Lead.", tick: (p) => { p.temp += 0.28; if (Math.random() < 0.008) spawnParticle(p.x, p.y, "alpha_particle", 1); if (Math.random() < 0.0001 && elements.lead) { safeChange(p, "lead"); return; } doDefaults(p); } },
    { id: "barium_141", color: ["#a3a89c", "#b5baa9"], moltenColor: ["#d9b977", "#ebca86"], gasColor: ["#cfd4c7", "#dfe3d8"], category: "isotopes", meltTemp: 727, boilTemp: 1897, density: 3510, conduct: 0.4, behavior: behaviors.POWDER, desc: "Fission daughter with delayed neutrons.", tick: (p) => { p.temp += 0.07; if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.00035) spawnNeutronsAround(p.x, p.y, 1, "thermal_neutron"); doDefaults(p); } },
    { id: "strontium_90", color: ["#c2c7b8", "#d3d9c7"], moltenColor: ["#e6c373", "#f2d183"], gasColor: ["#e0e3d8", "#edf0e6"], category: "isotopes", meltTemp: 777, boilTemp: 1382, density: 2640, conduct: 0.45, behavior: behaviors.POWDER, desc: "RTG beta source.", tick: (p) => { p.temp += 0.05; if (Math.random() < 0.002) spawnParticle(p.x, p.y, "beta_particle", 1); doDefaults(p); } },
    { id: "cesium_135", color: ["#d9c27e", "#e6cf8c"], moltenColor: ["#f0d88b", "#fce597"], gasColor: ["#ebdcb0", "#f5e8c1"], category: "isotopes", meltTemp: 28.5, boilTemp: 671, density: 1930, conduct: 0.65, behavior: behaviors.POWDER, desc: "Cesium-135." },
    { id: "beryllium", color: ["#8c9c94", "#9eb0a7", "#7d8c85"], moltenColor: ["#d99b66", "#eba971"], gasColor: ["#b5c4bc", "#c8d6cf"], category: "nuclear", meltTemp: 1287, boilTemp: 2470, density: 1850, conduct: 0.75, hardness: 0.8, desc: "Neutron reflector & multiplier.", reactions: { polonium_210: { chance: 0.03, func: p1 => { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 12; } }, americium_241: { chance: 0.02, func: p1 => { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 8; } } } },
    { id: "boron", color: ["#3a3330", "#4a413d", "#2e2826"], moltenColor: ["#b85e37", "#cc6b41"], gasColor: ["#786c67", "#8a7c76"], category: "nuclear", meltTemp: 2076, boilTemp: 3927, density: 2340, conduct: 0.15, hardness: 0.92, tickAllStates: true, desc: "Control rod & p-B11 fusion fuel (>55k C).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 55000 && Math.random() < 0.02 * fr) { const h = findAdjacentElement(p, "hydrogen"); if (h) { fusePair(p, h, "helium", "helium", 6500); return; } } doDefaults(p); } },
    { id: "cadmium", color: ["#9da8b8", "#adb8c9", "#8c96a6"], moltenColor: ["#cfd6e0", "#dfe6f0"], gasColor: ["#b8c2d1", "#cbd4e3"], category: "nuclear", meltTemp: 321, boilTemp: 767, density: 8650, conduct: 0.7, hardness: 0.45, desc: "Control-rod neutron absorber." },
    { id: "hafnium", color: ["#7a8491", "#8b95a3", "#697380"], moltenColor: ["#eb9952", "#ffa963"], gasColor: ["#a3adb8", "#b6c0cc"], category: "nuclear", meltTemp: 2233, boilTemp: 4603, density: 13310, conduct: 0.55, hardness: 0.88, desc: "High-temp control rod absorber." },
    { id: "tungsten", color: ["#5b616b", "#6b727d", "#4d525c"], moltenColor: ["#fff3b0", "#fff9d4"], gasColor: ["#a8b0bd", "#bcc4d1"], category: "metals", meltTemp: 3422, boilTemp: 5555, density: 19250, conduct: 0.78, hardness: 0.96, desc: "Highest-melting pure metal (3,422 C)." },
    { id: "lithium_6", color: ["#b8bcc2", "#c7cbd1"], moltenColor: ["#e0c59b", "#f0d4a8"], gasColor: ["#d6dae0", "#e6e9f0"], category: "isotopes", meltTemp: 180.5, boilTemp: 1342, density: 460, conduct: 0.6, hardness: 0.25, desc: "Breeds Tritium + He-4.", reactions: { water: { elem1: "hydrogen", elem2: "fire", chance: 0.22, func: p1 => { p1.temp += 260; } } } },
    { id: "lithium_7", color: ["#aeb3ba", "#bfc4cc"], moltenColor: ["#d9be93", "#e8cca0"], gasColor: ["#cfd4db", "#dfe4eb"], category: "isotopes", meltTemp: 180.5, boilTemp: 1342, density: 534, conduct: 0.6, hardness: 0.25, desc: "Lithium-7.", reactions: { water: { elem1: "hydrogen", elem2: "fire", chance: 0.22, func: p1 => { p1.temp += 260; } } } },
    { id: "nickel", color: ["#a8a89e", "#babab0", "#96968c"], moltenColor: ["#eb9a52", "#ffa961"], gasColor: ["#c7c7bd", "#d9d9cf"], category: "metals", meltTemp: 1455, boilTemp: 2913, density: 8908, conduct: 0.72, hardness: 0.75, behavior: behaviors.POWDER, desc: "Ferromagnetic metal (Curie: 358 C)." },
    { id: "cobalt", color: ["#587196", "#6682ab", "#4c6282"], moltenColor: ["#e6863e", "#f59851"], gasColor: ["#8da2c2", "#9fb4d4"], category: "metals", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.72, hardness: 0.78, behavior: behaviors.POWDER, desc: "Ferromagnetic metal (Curie: 1,115 C); activates to Co-60." },
    { id: "cobalt_60", color: ["#3b6eff", "#5985ff", "#2c5be6"], moltenColor: ["#7aa2ff", "#99b8ff"], gasColor: ["#6b93ff", "#88a8ff"], category: "isotopes", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.72, hardness: 0.78, desc: "Gamma emitter.", tick: (p) => { p.temp += 0.16; if (Math.random() < 0.006) spawnParticle(p.x, p.y, "gamma_ray", 1); doDefaults(p); } },
    { id: "neodymium", color: ["#8c929c", "#9da4b0"], moltenColor: ["#eb9b5e", "#ffa96e"], gasColor: ["#b4bac4", "#c5cbd6"], category: "metals", meltTemp: 1024, boilTemp: 3074, density: 7010, conduct: 0.5, hardness: 0.65, behavior: behaviors.POWDER, desc: "Rare-earth metal (Curie: 310 C)." },
    { id: "gadolinium", color: ["#a3b4bd", "#b5c6cf"], moltenColor: ["#e6aa6e", "#f5bb7f"], gasColor: ["#c7d6de", "#d9e6ed"], category: "metals", meltTemp: 1313, boilTemp: 3273, density: 7900, conduct: 0.45, hardness: 0.6, behavior: behaviors.POWDER, desc: "Magnetic thermal switch (Curie: 20 C)." },
    { id: "bismuth", color: ["#c7a4d6", "#9be3d8", "#f0c88c"], moltenColor: ["#d9d4e3", "#ebe6f5"], gasColor: ["#e0d5eb", "#efe6fa"], category: "metals", meltTemp: 271.4, boilTemp: 1564, density: 9780, conduct: 0.25, hardness: 0.4, behavior: behaviors.POWDER, desc: "Strongest room-temp diamagnet." },
    { id: "platinum", color: ["#d6dce3", "#e5ebf2", "#c4cbd4"], moltenColor: ["#ffe1b8", "#ffedd4"], gasColor: ["#e6ecf2", "#f2f7fc"], category: "metals", meltTemp: 1768, boilTemp: 3825, density: 21450, conduct: 0.85, hardness: 0.8, desc: "Catalyzes H2+O2 & Haber Ammonia (350-650 C).", tick: (p) => { if (Math.random() < 0.12) { const h = findAdjacentElement(p, "hydrogen"); if (h) { const o = findAdjacentElement(p, "oxygen"); if (o) { safeChange(h, "steam"); safeChange(o, "fire"); p.temp += 100; return; } if (p.temp >= 350 && p.temp <= 650 && elements.ammonia) { const n = findAdjacentElement(p, "nitrogen"); if (n) { safeChange(h, "ammonia"); safeChange(n, "ammonia"); p.temp += 50; return; } } } } doDefaults(p); } },
    { id: "cesium", color: ["#e3cf86", "#edda95", "#d4bf77"], moltenColor: ["#f5e29d", "#ffedab"], gasColor: ["#f2e6bd", "#fcf1cc"], category: "metals", meltTemp: 28.5, boilTemp: 671, density: 1930, conduct: 0.72, hardness: 0.1, behavior: behaviors.POWDER, desc: "Explodes with water/ice.", reactions: { water: { chance: 0.65, func: p1 => { safeChange(p1, "hydrogen"); p1.temp += 1100; explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } }, ice: { chance: 0.45, func: p1 => { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } }, oxygen: { elem1: "fire", elem2: "ash", tempMin: 35, chance: 0.2 } } },
    { id: "rubidium", color: ["#c9cfd6", "#d8dee6"], moltenColor: ["#dfe5ed", "#edf2f7"], gasColor: ["#cfd6de", "#dee4eb"], category: "metals", meltTemp: 39.3, boilTemp: 688, density: 1532, conduct: 0.7, hardness: 0.12, behavior: behaviors.POWDER, desc: "Explodes with water.", reactions: { water: { chance: 0.6, func: p1 => { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 3, "fire,hydrogen,steam"); } } } },
    { id: "gallium", color: ["#b4c2d1", "#c5d2e0", "#a4b2c2"], moltenColor: ["#d4e0ed", "#e3edf7"], gasColor: ["#c7d4e3", "#d8e4f2"], category: "metals", meltTemp: 29.8, boilTemp: 2400, density: 5910, conduct: 0.65, hardness: 0.35, desc: "Melts at 29.8 C; embrittles Aluminum.", reactions: { aluminum: { elem2: "metal_scrap", chance: 0.14 } } },
    { id: "phosphorus_white", color: ["#f5f0c4", "#fffad1", "#e8e2b0"], moltenColor: ["#fff49e", "#fff9ba"], gasColor: ["#f0ebb9", "#faf5c8"], category: "chemistry", meltTemp: 44.1, boilTemp: 280.5, density: 1823, conduct: 0.05, hardness: 0.2, behavior: behaviors.POWDER, desc: "Pyrophoric (>30 C in O2); forms Red Phosphorus >250 C.", tick: (p) => { if (p.temp >= 250 && p.temp < 400 && Math.random() < 0.02 && !findAdjacentElement(p, "oxygen")) { safeChange(p, "phosphorus_red"); return; } doDefaults(p); }, reactions: { oxygen: { elem1: "fire", elem2: "smoke", tempMin: 30, chance: 0.28, func: p1 => { p1.temp += 700; } } } },
    { id: "phosphorus_red", color: ["#9e2b25", "#b5352e", "#87221d"], moltenColor: ["#d94a38", "#eb5a46"], gasColor: ["#f0ebb9", "#faf5c8"], category: "chemistry", meltTemp: 590, boilTemp: 620, density: 2340, conduct: 0.05, hardness: 0.35, behavior: behaviors.POWDER, desc: "Stable Red Phosphorus.", reactions: { oxygen: { elem1: "fire", elem2: "smoke", tempMin: 260, chance: 0.2, func: p1 => { p1.temp += 650; } } } },
    { id: "alumina", color: ["#e8ecf0", "#f2f5f7", "#d8dde3"], moltenColor: ["#ffcf9e", "#ffe0bd"], gasColor: ["#e6eaed", "#f5f8fa"], category: "chemistry", meltTemp: 2072, boilTemp: 2977, density: 3950, conduct: 0.1, hardness: 0.9, behavior: behaviors.POWDER, desc: "Al2O3 Thermite slag." },
    { id: "osmium", color: ["#526075", "#5f6e85", "#465366"], moltenColor: ["#e69653", "#f5a764"], gasColor: ["#7c8ba3", "#8d9cb5"], category: "metals", meltTemp: 3033, boilTemp: 5012, density: 22590, conduct: 0.7, hardness: 0.95, desc: "Densest natural element." }
  ].forEach(defineFullElement);

  // ---------------------------------------------------------------------------
  // 9. DARK-MODE SETTINGS PANEL + QUIET TOAST + BETTERSETTINGS SYNC
  // ---------------------------------------------------------------------------

  const uiControls = {};
  let statsEl = null, panelEl = null;

  function syncSettingsUI() {
    for (const k of Object.keys(uiControls)) {
      const c = uiControls[k];
      if (!c) continue;
      if (c.type === "checkbox") c.checked = !!UPC_CONFIG[k]; else c.value = String(UPC_CONFIG[k]);
      if (c._valLabel) c._valLabel.textContent = String(UPC_CONFIG[k]);
    }
  }

  function applyPreset(name) {
    const presets = {
      default: DEFAULT_CONFIG,
      stellar: { gravityMethod: "star", fieldTileSize: 4, fieldRebuildInterval: 2, gravAccel: 0.038, compressionHeatScale: 1.0, radiativeCooling: true, collapseThresholdScale: 1.0, showPackGlow: true, starDrag: 0.998, fusionRate: 1.0, supernovaEnabled: true, autoBonding: false },
      reactor: { gravityMethod: "element", fieldTileSize: 4, fieldRebuildInterval: 2, fissionRate: 1.0, fissionHeatScale: 1.0, maxNeutrons: 420, delayedNeutrons: true, plasmaConfinement: true, autoBonding: true },
      fast:    { gravityMethod: "com", fieldTileSize: 6, fieldRebuildInterval: 4, maxNeutrons: 200, maxBonds: 300, showFields: false, showPackGlow: false }
    };
    if (presets[name]) Object.assign(UPC_CONFIG, presets[name]);
    applyUPCConfig(true);
    notifyUser("Preset applied: " + name, true);
  }

  function createSettingsUI() {
    if (typeof document === "undefined" || document.getElementById("upc-settings-btn")) return;
    const style = document.createElement("style");
    style.textContent = `
      #upc-settings-btn{position:fixed;top:10px;right:12px;z-index:99998;background:#181a22;color:#e6ecff;border:1px solid #3c4663;border-radius:6px;padding:6px 11px;font:600 12px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45)}
      #upc-settings-btn:hover{background:#232838;border-color:#66b2ff}
      #upc-settings-panel{position:fixed;top:44px;right:12px;z-index:99999;width:332px;max-height:calc(100vh - 64px);overflow-y:auto;background:rgba(18,20,27,.96);color:#e2e8f5;border:1px solid #343d54;border-radius:9px;padding:12px 14px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.65);display:none}
      #upc-settings-panel h3{margin:0 0 8px;font-size:14px;color:#7cc4ff;display:flex;justify-content:space-between;align-items:center}
      #upc-settings-panel .upc-sec{margin:10px 0 5px;padding-top:7px;border-top:1px solid #2b3245;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8c9bbd}
      #upc-settings-panel .upc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}
      #upc-settings-panel label{flex:1;color:#d5ddf0}
      #upc-settings-panel select,#upc-settings-panel input[type="range"]{width:136px;background:#101218;color:#eef3ff;border:1px solid #39435e;border-radius:4px;padding:2px 4px;font-size:11.5px}
      #upc-settings-panel .upc-val{width:38px;text-align:right;color:#8cd1ff;font-variant-numeric:tabular-nums}
      #upc-settings-panel .upc-presets{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 8px}
      #upc-settings-panel button.upc-act{background:#23293a;color:#dce6ff;border:1px solid #3a4563;border-radius:5px;padding:5px 7px;font-size:11px;cursor:pointer}
      #upc-settings-panel button.upc-act:hover{background:#2e3852;border-color:#7cc4ff}
      #upc-stats-bar{background:#11131a;border:1px solid #272e40;border-radius:5px;padding:6px 8px;font:11px/1.45 ui-monospace,Consolas,monospace;color:#9ad1b8;margin-bottom:6px;white-space:pre-line}
      #upc-toast{position:fixed;bottom:10px;left:12px;z-index:99997;max-width:72vw;background:rgba(16,18,25,.90);color:#d8e6ff;border:1px solid #33405c;border-radius:6px;padding:5px 10px;font:11.5px/1.35 ui-monospace,Consolas,monospace;pointer-events:none;opacity:0;transition:opacity .25s ease}
    `;
    document.head.appendChild(style);

    toastEl = document.createElement("div"); toastEl.id = "upc-toast"; document.body.appendChild(toastEl);
    const btn = document.createElement("button"); btn.id = "upc-settings-btn"; btn.textContent = "Physics Settings"; btn.title = "Unified Physics Settings (Shift+P)"; document.body.appendChild(btn);

    panelEl = document.createElement("div"); panelEl.id = "upc-settings-panel";
    ["mousedown", "mouseup", "click", "wheel", "keydown", "keyup", "touchstart"].forEach(ev => panelEl.addEventListener(ev, e => e.stopPropagation()));
    panelEl.innerHTML = '<h3><span>Unified Physics v8</span><span style="cursor:pointer;color:#7e8ba8" id="upc-close-x">✕</span></h3>';

    statsEl = document.createElement("div"); statsEl.id = "upc-stats-bar";
    statsEl.textContent = "Tick: 0.00 ms | MaxPack: 1.0x\nTiles G:0 B:0 | Bonds:0 | n:0";
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

    addSec("Gravity & Mass-Packing");
    addSel("Gravity Method", "gravityMethod", [["element", "Element-Based (star_gravity/wells)"], ["star", "Multi-Body CIC (Always On)"], ["com", "Fast Center-of-Mass"], ["wells_only", "Gravity Wells / Cores Only"], ["off", "Off (Vanilla Only)"]]);
    addSel("Tile Resolution", "fieldTileSize", [[2, "2x2 (Ultra Sharp)"], [4, "4x4 (Balanced)"], [6, "6x6 (Fast)"], [8, "8x8 (Max FPS)"]]);
    addSld("Rebuild Every (ticks)", "fieldRebuildInterval", 1, 6, 1);
    addSld("Gravity Strength", "gravAccel", 0, 0.12, 0.004);
    addSld("Adiabatic Pack Heating", "compressionHeatScale", 0, 2.5, 0.1);
    addSld("Collapse Threshold", "collapseThresholdScale", 0.3, 3.0, 0.1);
    addTgl("Stellar Radiative Cooling", "radiativeCooling");
    addTgl("Glow Packed Cores", "showPackGlow");
    addSld("Max Pixel Speed", "maxSpeed", 0.5, 3.5, 0.1);
    addSld("Orbital Drag", "starDrag", 0.94, 1.0, 0.002);

    addSec("Magnets & Plasma");
    addSld("Magnetic Strength", "magScale", 0, 3.0, 0.1);
    addTgl("Tokamak Plasma Confinement", "plasmaConfinement");
    addTgl("Curie Temp Demagnetization", "curieDemagnetize");
    addTgl("Show Field Vectors Overlay", "showFields");

    addSec("Nuclear & Fusion");
    addSld("Fusion Rate", "fusionRate", 0, 3.0, 0.1);
    addSld("Fission Rate", "fissionRate", 0.1, 3.0, 0.1);
    addSld("Fission Heat Scale", "fissionHeatScale", 0.2, 3.0, 0.1);
    addSld("Neutron Cap", "maxNeutrons", 60, 800, 20);
    addTgl("Delayed Neutrons", "delayedNeutrons");
    addTgl("Supernova & Collapse", "supernovaEnabled");

    addSec("Chemical Bonding");
    addTgl("Auto Chemical Bonding", "autoBonding");
    addTgl("Render Bond Lines", "showBonds");
    addSld("Max Bond Edges", "maxBonds", 0, 1800, 50);

    const aRow = document.createElement("div"); aRow.className = "upc-presets";
    const cbBtn = document.createElement("button"); cbBtn.className = "upc-act"; cbBtn.textContent = "Break All Bonds";
    cbBtn.onclick = () => { clearAllBonds(); notifyUser("Cleared all chemical bonds.", true); };
    const zvBtn = document.createElement("button"); zvBtn.className = "upc-act"; zvBtn.textContent = "Zero All Velocity";
    zvBtn.onclick = () => {
      for (let i = 0; i < currentPixels.length; i++) { const p = currentPixels[i]; if (p) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; p.inwardImpulse = 0; } }
      movingPixelsLastTick = 0; notifyUser("Zeroed velocity on all pixels.", true);
    };
    aRow.append(cbBtn, zvBtn); panelEl.appendChild(aRow);
    document.body.appendChild(panelEl);

    const togglePanel = () => { const open = panelEl.style.display === "block"; panelEl.style.display = open ? "none" : "block"; if (!open) syncSettingsUI(); };
    btn.onclick = (e) => { e.stopPropagation(); togglePanel(); };
    const cx = document.getElementById("upc-close-x"); if (cx) cx.onclick = togglePanel;

    window.addEventListener("keydown", (e) => {
      if (e.shiftKey && (e.key === "P" || e.key === "p")) {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault(); togglePanel();
      }
    });

    setInterval(() => {
      if (!panelEl || panelEl.style.display !== "block" || !statsEl) return;
      statsEl.textContent = `Tick: ${UPC_STATS.lastTickMs.toFixed(2)} ms | MaxPack: ${UPC_STATS.maxPack.toFixed(1)}x\nTiles G:${UPC_STATS.activeGravTiles} B:${UPC_STATS.activeMagTiles} | Bonds:${UPC_STATS.activeBonds} | n:${UPC_STATS.activeNeutrons}\nStatus: ${UPC_STATS.lastEvent}`;
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
  // 10. PATCH VANILLA & CHEM.JS + OZONE FIX + RECURSIVE TICK SANITIZER
  // ---------------------------------------------------------------------------

  function initUnifiedPhysics() {
    applyUPCConfig(false);

    if (!elements.iron_gas) registerOrEnhance("iron_gas", { color: ["#ffb870", "#ffc98f"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 7.8, temp: 2950, tempLow: 2862, stateLow: "molten_iron" });
    if (elements.molten_iron && !elements.molten_iron.stateHigh) { elements.molten_iron.tempHigh = 2862; elements.molten_iron.stateHigh = "iron_gas"; }

    if (elements.neutron) { elements.neutron.desc = "Free neutron (Unified Physics v8)."; if (!elements.neutron.reactions) elements.neutron.reactions = {}; delete elements.neutron.tick1; delete elements.neutron.tick2; elements.neutron.tick = (p) => neutronTick(p, true); }
    if (elements.uranium) { elements.uranium.desc = "Natural/Low-Enriched Uranium (patched)."; delete elements.uranium.tick1; delete elements.uranium.tick2; elements.uranium.tick = (p) => { if (Math.random() < 0.00003) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); }; }
    if (elements.plutonium) { elements.plutonium.desc = "Plutonium-239 (patched)."; delete elements.plutonium.tick1; delete elements.plutonium.tick2; elements.plutonium.tick = (p) => { p.temp += 0.03; if (Math.random() < 0.00012) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); }; }

    // Cap Oxygen -> Ozone to <= 350 C and thermally decompose hot Ozone back to Oxygen
    for (const k in elements) {
      const rx = elements[k]?.reactions;
      if (!rx) continue;
      for (const rk in rx) {
        const r = rx[rk];
        if (!r || typeof r !== "object") continue;
        if ((k === "oxygen" || rk === "oxygen") && (r.elem1 === "ozone" || r.elem2 === "ozone")) {
          r.tempMax = 350;
          if (r.chance === undefined || r.chance > 0.04) r.chance = 0.04;
        }
      }
    }
    if (elements.ozone) wrapTick("ozone", (p) => (p.temp >= 350 && Math.random() < (p.temp >= 800 ? 0.65 : 0.14) ? (safeChange(p, "oxygen"), true) : false));

    // Stellar Fusion Hooks (mass-conserving & paced)
    if (elements.hydrogen) wrapTick("hydrogen", (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 50000 && Math.random() < 0.012 * fr) { const o = findAdjacentElement(p, "hydrogen"); if (o) { fusePair(p, o, "deuterium", "positron", 2800); return true; } } return false; });
    if (elements.helium) wrapTick("helium", (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 65000 && Math.random() < 0.011 * fr) { const o = findAdjacentElement(p, "helium"); if (o) { fusePair(p, o, "carbon_vapor", "gamma_ray", 3800); return true; } } return false; });
    if (elements.oxygen) wrapTick("oxygen", (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 95000 && Math.random() < 0.014 * fr) { const o = findAdjacentElement(p, "oxygen"); if (o) { fusePair(p, o, Math.random() < 0.75 ? "silicon_gas" : (elements.sulfur_gas ? "sulfur_gas" : "silicon_gas"), "gamma_ray", 2800); return true; } } return false; });

    // Thermal Dissociation
    if (elements.carbon_dioxide) wrapTick("carbon_dioxide", (p) => (p.temp >= 4000 && Math.random() < 0.08 ? (safeChange(p, Math.random() < 0.5 ? "carbon_vapor" : "oxygen"), true) : false));
    if (elements.steam) wrapTick("steam", (p) => (p.temp >= 3200 && Math.random() < 0.07 ? (safeChange(p, Math.random() < 0.66 ? "hydrogen" : "oxygen"), true) : false));
    if (elements.ammonia) wrapTick("ammonia", (p) => (p.temp >= 1200 && Math.random() < 0.08 ? (safeChange(p, Math.random() < 0.75 ? "hydrogen" : "nitrogen"), true) : false));
    if (elements.sand) wrapTick("sand", (p) => (p.temp >= 4500 && Math.random() < 0.06 ? (safeChange(p, Math.random() < 0.45 ? "silicon_gas" : "oxygen"), true) : false));

    if (elements.rust && elements.aluminum) safeAddReaction("rust", "aluminum", { elem1: "molten_iron", elem2: "alumina", tempMin: 1200, chance: 0.22, func: (p1, p2) => { p1.temp += 1500; p2.temp += 1500; } });
    if (elements.uranium_dioxide) FISSILE_SPECS.uranium_dioxide = { th: 0.16, fa: 0.015, n: [2, 3], heat: 1200, d: ["barium_141", "krypton_92", "xenon_135"] };

    if (typeof window !== "undefined" && typeof window.tickPixels === "function" && !window.tickPixels._upcWrapped) {
      const origTick = window.tickPixels;
      const wrappedTick = function (...args) {
        const res = origTick.apply(this, args);
        const t0 = performance.now();
        try { updateGravityAndCompressionTick(); updateBondsTick(); } catch (err) { console.error("[UPC] tick:", err); }
        UPC_STATS.lastTickMs = performance.now() - t0;
        return res;
      };
      wrappedTick._upcWrapped = true; window.tickPixels = wrappedTick;
    }

    if (typeof window !== "undefined" && typeof window.drawPixels === "function" && !window.drawPixels._upcWrapped) {
      const origDraw = window.drawPixels;
      const wrappedDraw = function (...args) {
        const res = origDraw.apply(this, args);
        try { drawFieldOverlay(); drawShockwavesAndPackGlow(); drawActiveBonds(); } catch (err) {}
        return res;
      };
      wrappedDraw._upcWrapped = true; window.drawPixels = wrappedDraw;
    }

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

    console.log("[unified_physics_chem] Loaded v8 successfully!");
  }

  if (typeof runAfterLoad === "function") runAfterLoad(initUnifiedPhysics);
  else initUnifiedPhysics();
})();
