/*
 * Unified Physics & Chemistry v13 (unified_physics_chem.js)
 * Complete drop-in companion add-on for Sandboxels + chem.js
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. LIVE CONFIG, PERSISTENCE & QUIET TOAST
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "upc_v13_settings";
  const DEFAULT_CONFIG = {
    gravityMethod: "element",     // "element" | "star" | "com" | "wells_only" | "off"
    fieldTileSize: 4,             // 2 | 4 | 6 | 8
    fieldRebuildInterval: 2,
    zeroVanillaGravity: true,
    gravAccel: 0.032,
    pressureForceScale: 1.3,
    compressionHeatScale: 1.2,
    radiativeCooling: true,
    minBhMass: 75,
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
    if (saved) for (const k of Object.keys(DEFAULT_CONFIG)) if (saved[k] !== undefined && saved[k] !== null) UPC_CONFIG[k] = saved[k];
  } catch (e) {}

  function saveConfig() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(UPC_CONFIG)); } catch (e) {} }

  let FIELD_BLOCK = 4, FIELD_REBUILD_INTERVAL = 2, MAX_SPEED = 2.6, GRAV_ACCEL = 0.032;
  let MAG_POLE_ACCEL = 0.18, MAG_FERRO_ACCEL = 0.55, MAG_MEISSNER_ACCEL = 0.72, MAG_DIAMAG_ACCEL = 0.14, MAG_PLASMA_ACCEL = 0.45;
  let MAX_NEUTRONS = 320, MAX_BONDS = 700, activeFieldBlock = 4, lastGridW = 0, lastGridH = 0, inVanillaTick = false;

  const MAX_PACK = 160;
  const NS_MIN_TEMP = 45000;
  const UPC_STATS = { lastTickMs: 0, activeGravTiles: 0, activeMagTiles: 0, movingPixels: 0, activeNeutrons: 0, activeBonds: 0, maxPack: 1, totalBhMass: 0, lastEvent: "Ready" };

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

  function clampNum(v, lo, hi, fb) { const n = Number(v); return Number.isNaN(n) ? fb : Math.max(lo, Math.min(hi, n)); }

  function restoreAllTints() {
    if (typeof currentPixels === "undefined" || !currentPixels) return;
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (p && p._tinted && p._baseColor) { p.color = p._baseColor; p._tinted = false; }
    }
  }

  function applyUPCConfig(persist = true) {
    const nb = Math.max(2, Math.min(8, parseInt(UPC_CONFIG.fieldTileSize, 10) || 4));
    if (nb !== FIELD_BLOCK) { FIELD_BLOCK = nb; kernelX = null; }
    FIELD_REBUILD_INTERVAL = Math.max(1, Math.min(6, parseInt(UPC_CONFIG.fieldRebuildInterval, 10) || 2));
    GRAV_ACCEL = clampNum(UPC_CONFIG.gravAccel, 0, 0.25, DEFAULT_CONFIG.gravAccel);
    UPC_CONFIG.pressureForceScale = clampNum(UPC_CONFIG.pressureForceScale, 0, 3.0, 1.3);
    UPC_CONFIG.compressionHeatScale = clampNum(UPC_CONFIG.compressionHeatScale, 0, 2.5, 1.2);
    UPC_CONFIG.minBhMass = Math.round(clampNum(UPC_CONFIG.minBhMass, 25, 400, 75));
    UPC_CONFIG.collapseThresholdScale = clampNum(UPC_CONFIG.collapseThresholdScale, 0.3, 3.0, 1.0);
    const ms = clampNum(UPC_CONFIG.magScale, 0, 4.0, 1.0);
    MAG_POLE_ACCEL = 0.18 * ms; MAG_FERRO_ACCEL = 0.55 * ms; MAG_MEISSNER_ACCEL = 0.72 * ms; MAG_DIAMAG_ACCEL = 0.14 * ms; MAG_PLASMA_ACCEL = 0.45 * ms;
    MAX_SPEED = clampNum(UPC_CONFIG.maxSpeed, 0.5, 3.5, 2.6);
    MAX_NEUTRONS = Math.round(clampNum(UPC_CONFIG.maxNeutrons, 40, 800, 320));
    MAX_BONDS = Math.round(clampNum(UPC_CONFIG.maxBonds, 0, 2000, 700));
    UPC_CONFIG.starDrag = clampNum(UPC_CONFIG.starDrag, 0.85, 1.0, 0.996);
    UPC_CONFIG.fusionRate = clampNum(UPC_CONFIG.fusionRate, 0, 3.0, 1.0);
    UPC_CONFIG.fissionRate = clampNum(UPC_CONFIG.fissionRate, 0.1, 3.0, 1.0);
    UPC_CONFIG.fissionHeatScale = clampNum(UPC_CONFIG.fissionHeatScale, 0.2, 3.0, 1.0);
    if (!UPC_CONFIG.showPackGlow) restoreAllTints();
    lastFieldTick = -100;
    if (persist) saveConfig();
    if (typeof syncSettingsUI === "function") syncSettingsUI();
  }

  if (typeof window !== "undefined") {
    window.UPC_CONFIG = UPC_CONFIG; window.UPC_STATS = UPC_STATS; window.applyUPCConfig = applyUPCConfig;
  }

  // ---------------------------------------------------------------------------
  // 2. CORE UTILITIES, COLOR SHIFTING, SAFE REACTIONS & ELEMENT BUILDERS
  // ---------------------------------------------------------------------------

  const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const randomDir = () => DIRS[Math.floor(Math.random() * 8)];
  const inSafeBounds = (x, y) => !outOfBounds(x, y) && pixelMap[x] !== undefined;

  function safeChange(p, name) { if (!p || p.del || !elements[name]) return false; changePixel(p, name); p._baseElem = null; p._tinted = false; return true; }
  function safeChangeAny(p, list) { if (!p || p.del) return false; for (let i = 0; i < list.length; i++) if (elements[list[i]]) { changePixel(p, list[i]); p._baseElem = null; p._tinted = false; return true; } return false; }
  function safeCreate(name, x, y) { if (!elements[name] || !inSafeBounds(x, y) || !isEmpty(x, y)) return null; createPixel(name, x, y); return pixelMap[x][y] || null; }

  function safeReact(p1, p2) {
    if (!p1 || !p2 || p1.del || p2.del || typeof reactPixels !== "function") return;
    if (elements[p1.element]?.reactions?.[p2.element]) { try { reactPixels(p1, p2); } catch (e) {} }
    else if (elements[p2.element]?.reactions?.[p1.element]) { try { reactPixels(p2, p1); } catch (e) {} }
  }

  function safeSwap(p1, p2) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del) return false;
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    if (!inSafeBounds(x1, y1) || !inSafeBounds(x2, y2)) return false;
    p1.x = x2; p1.y = y2; p2.x = x1; p2.y = y1;
    pixelMap[x1][y1] = p2; pixelMap[x2][y2] = p1;
    return true;
  }

  function findAdj(p, target) {
    const start = Math.floor(Math.random() * 8), isSet = target instanceof Set;
    for (let i = 0; i < 8; i++) {
      const d = DIRS[(start + i) & 7], nx = p.x + d[0], ny = p.y + d[1];
      if (!inSafeBounds(nx, ny)) continue;
      const o = pixelMap[nx][ny];
      if (o && !o.del && (isSet ? target.has(o.element) : o.element === target)) return o;
    }
    return null;
  }

  function parseRGB(str) {
    if (typeof str !== "string") return [180, 180, 180];
    if (str[0] === "#") {
      const hex = str.length === 4 ? str[1] + str[1] + str[2] + str[2] + str[3] + str[3] : str.slice(1, 7);
      const n = parseInt(hex, 16);
      return Number.isNaN(n) ? [180, 180, 180] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = str.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [180, 180, 180];
  }

  function updatePackColor(p) {
    if (!p || p.del || p.element === "black_hole_core") return;
    if (p._baseElem !== p.element) {
      p._baseElem = p.element;
      p._baseColor = typeof p.color === "string" ? p.color : "rgb(180,180,180)";
      p._tinted = false;
    }
    const pk = p.pack || 1;
    if (!UPC_CONFIG.showPackGlow || (pk <= 1.05 && !(p.bounceTicks > 0))) {
      if (p._tinted && p._baseColor) { p.color = p._baseColor; p._tinted = false; }
      return;
    }
    const wall = getWallPack(p.element);
    let tr, tg, tb, blend;
    if (p.bounceTicks > 0 || pk >= wall) { tr = 240; tg = 248; tb = 255; blend = 0.92; }
    else if (pk >= 7.0) { tr = 255; tg = 65; tb = 225; blend = 0.85; }
    else if (pk >= 3.5) { tr = 255; tg = 110; tb = 42; blend = 0.78; }
    else if (pk >= 1.8) { tr = 255; tg = 212; tb = 55; blend = 0.70; }
    else { tr = 65; tg = 225; tb = 255; blend = 0.58; }

    const b = parseRGB(p._baseColor);
    const r = Math.round(b[0] + (tr - b[0]) * blend);
    const g = Math.round(b[1] + (tg - b[1]) * blend);
    const bl = Math.round(b[2] + (tb - b[2]) * blend);
    p.color = `rgb(${r},${g},${bl})`;
    p._tinted = true;
  }

  function getFusionFactor(p) {
    if (UPC_CONFIG.fusionRate <= 0) return 0;
    return UPC_CONFIG.fusionRate * Math.min(2.6, 0.72 + Math.log2(p.pack || 1) * 0.52);
  }

  function injectRadPulse(cx, cy, amt) {
    for (let i = 0; i < 8; i++) {
      const nx = cx + DIRS[i][0], ny = cy + DIRS[i][1];
      if (!inSafeBounds(nx, ny)) continue;
      const nb = pixelMap[nx][ny];
      if (nb && !nb.del) nb.radEnergy = Math.min(380, (nb.radEnergy || 0) + amt);
    }
  }

  const LIGHT_PRODS = new Set(["gamma_ray", "fast_neutron", "positron", "proton", "radiation"]);
  function fusePair(p1, p2, prod1, prod2, heat, radBoost = 70) {
    if (!p1 || !p2 || p1.del || p2.del) return false;
    const pk1 = p1.pack || 1, pk2 = p2.pack || 1;
    safeChange(p1, prod1);
    if (prod2 === "positron") safeChangeAny(p2, ["positron", "gamma_ray", "radiation"]);
    else if (prod2 === "proton") safeChangeAny(p2, ["proton", "hydrogen"]);
    else safeChange(p2, prod2);
    if (LIGHT_PRODS.has(prod2)) { p1.pack = Math.min(MAX_PACK, +(pk1 + pk2 * 0.65).toFixed(2)); p2.pack = 1; }
    else { const avg = Math.min(MAX_PACK, +((pk1 + pk2) * 0.5).toFixed(2)); p1.pack = avg; p2.pack = avg; }
    p1.temp = Math.min(280000, p1.temp + heat); p2.temp = Math.min(280000, p2.temp + heat);
    p1.radEnergy = Math.min(380, (p1.radEnergy || 0) + radBoost);
    p2.radEnergy = Math.min(380, (p2.radEnergy || 0) + Math.round(radBoost * 0.65));
    injectRadPulse(p1.x, p1.y, Math.round(radBoost * 0.34));
    updatePackColor(p1); updatePackColor(p2);
    return true;
  }

  function safeAddReaction(e, t, rx) { if (!elements[e]) return; if (!elements[e].reactions) elements[e].reactions = {}; elements[e].reactions[t] = rx; }

  function wrapTick(name, fn) {
    const el = elements[name];
    if (!el || el.tool) return;
    if (typeof el.tick1 === "function" && !String(el.tick1).includes("tick1")) {
      const o1 = el.tick1;
      el.tick1 = (p) => { if (!p || p.del) return; if (fn(p) === true) return; if (!p.del) o1(p); };
      return;
    }
    const prev = typeof el.tick === "function" ? el.tick : null;
    el.tick = (p) => { if (!p || p.del) return; if (fn(p) === true) return; if (!p.del) (prev ? prev(p) : doDefaults(p)); };
  }

  function reg(name, def) {
    const clean = {};
    for (const k of Object.keys(def)) {
      if (k === "_override" || (k === "tick" && typeof def[k] !== "function") || def[k] === undefined || def[k] === null) continue;
      clean[k] = def[k];
    }
    if (!clean.tool && !clean.reactions) clean.reactions = {};
    if (elements[name]) {
      const ex = elements[name];
      if (clean.reactions) ex.reactions = Object.assign({}, ex.reactions || {}, clean.reactions);
      for (const k of Object.keys(clean)) if (k !== "reactions" && (ex[k] === undefined || def._override)) ex[k] = clean[k];
    } else elements[name] = clean;
  }

  function defSolid(c) {
    const { id, color, moltenColor, gasColor, category = "solids", meltTemp, boilTemp, density, conduct = 0.5, hardness = 0.7, behavior = behaviors.WALL, reactions = {}, tick, tickAllStates = false, desc = "" } = c;
    const mId = "molten_" + id, gId = id + "_gas", ht = typeof tick === "function";
    const sD = { color, behavior, category, state: "solid", density, conduct, hardness, tempHigh: meltTemp, stateHigh: mId, reactions: Object.assign({}, reactions), desc };
    if (ht) sD.tick = tick; reg(id, sD);
    const mD = { color: moltenColor || ["#ff7b29", "#ff9e3d", "#ffb84d"], behavior: behaviors.LIQUID, category: "states", state: "liquid", hidden: true, density: Math.round(density * 0.9), conduct: conduct * 0.8, temp: meltTemp + 50, tempLow: meltTemp, stateLow: id, tempHigh: boilTemp, stateHigh: gId, viscosity: 14, reactions: Object.assign({}, reactions) };
    if (ht) mD.tick = tick; reg(mId, mD);
    const gD = { color: gasColor || ["#d9d9d9", "#bfbfbf"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: Math.max(0.5, +(density / 1000).toFixed(2)), temp: boilTemp + 50, tempLow: boilTemp, stateLow: mId, reactions: Object.assign({}, reactions) };
    if (ht && tickAllStates) gD.tick = tick; reg(gId, gD);
  }

  function defGas(c) {
    const { id, color, liquidColor, solidColor, category = "gases", boilTemp, meltTemp, density, reactions = {}, tick, desc = "", conduct } = c;
    const lId = "liquid_" + id, sId = "solid_" + id, ht = typeof tick === "function";
    const gD = { color, behavior: behaviors.GAS, category, state: "gas", density, tempLow: boilTemp, stateLow: lId, reactions: Object.assign({}, reactions), desc };
    if (conduct !== undefined) gD.conduct = conduct; if (ht) gD.tick = tick; reg(id, gD);
    const lD = { color: liquidColor || color, behavior: behaviors.LIQUID, category: "states", state: "liquid", hidden: true, density: Math.max(50, Math.round(density * 600)), temp: boilTemp - 5, tempHigh: boilTemp, stateHigh: id, tempLow: meltTemp, stateLow: sId, reactions: Object.assign({}, reactions) };
    if (ht) lD.tick = tick; reg(lId, lD);
    const sD = { color: solidColor || liquidColor || color, behavior: behaviors.WALL, category: "states", state: "solid", hidden: true, density: Math.max(80, Math.round(density * 750)), temp: meltTemp - 5, tempHigh: meltTemp, stateHigh: lId, reactions: Object.assign({}, reactions) };
    if (ht) sD.tick = tick; reg(sId, sD);
  }

  // ---------------------------------------------------------------------------
  // 3. EXTERNAL-GRAPH CHEMICAL BONDING ENGINE (100% JSON / UNDO SAFE)
  // ---------------------------------------------------------------------------

  const bondGraph = new Map();
  let totalBondEdges = 0;
  const RAD_AGENTS = new Set(["radiation", "fast_neutron", "alpha_particle", "beta_particle", "gamma_ray"]);
  const BOND_RULES = {
    "hydrogen|hydrogen": { t: "covalent", bt: 3500, lo: -250, hi: 2500, pr: 0.04, a: 1, b: 1 },
    "hydrogen|oxygen": { t: "polar", bt: 2800, lo: 120, hi: 2200, pr: 0.08, a: 1, b: 2 },
    "deuterium|oxygen": { t: "polar", bt: 2850, lo: 120, hi: 2200, pr: 0.08, a: 1, b: 2 },
    "chlorine|sodium": { t: "ionic", bt: 1450, lo: -50, hi: 1100, pr: 0.14, a: 1, b: 1 },
    "chlorine|hydrogen": { t: "polar", bt: 2200, lo: -100, hi: 1600, pr: 0.08, a: 1, b: 1 },
    "nitrogen|nitrogen": { t: "covalent", bt: 5500, lo: -200, hi: 4000, pr: 0.03, a: 1, b: 1 },
    "hydrogen|nitrogen": { t: "polar", bt: 1300, lo: 350, hi: 900, pr: 0.04, a: 1, b: 3 },
    "carbon_vapor|oxygen": { t: "covalent", bt: 3800, lo: 600, hi: 3200, pr: 0.06, a: 2, b: 2 },
    "graphite|graphite": { t: "covalent", bt: 4200, lo: 800, hi: 3400, pr: 0.02, a: 3, b: 3 },
    "silicon|silicon": { t: "covalent", bt: 2600, lo: 200, hi: 2200, pr: 0.02, a: 4, b: 4 },
    "oxygen|silicon": { t: "covalent", bt: 3000, lo: 700, hi: 2400, pr: 0.05, a: 2, b: 4 },
    "magnesium|oxygen": { t: "ionic", bt: 2800, lo: 400, hi: 2300, pr: 0.10, a: 2, b: 2 },
    "cesium|chlorine": { t: "ionic", bt: 1300, lo: -50, hi: 900, pr: 0.14, a: 1, b: 1 },
    "iron|oxygen": { t: "ionic", bt: 2200, lo: 300, hi: 1600, pr: 0.03, a: 2, b: 2 },
    "aluminum|oxygen": { t: "ionic", bt: 2900, lo: 500, hi: 2400, pr: 0.04, a: 3, b: 2 }
  };

  const getBonds = (p) => bondGraph.get(p) || null;
  const getBondCount = (p) => (bondGraph.get(p)?.length || 0);
  const hasBond = (p1, p2) => (bondGraph.get(p1)?.some(b => b.target === p2) || false);

  function createBond(p1, p2, type = "covalent", breakTemp = 2500) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del || totalBondEdges >= MAX_BONDS || hasBond(p1, p2)) return false;
    let b1 = bondGraph.get(p1), b2 = bondGraph.get(p2);
    if ((b1 && b1.length >= 4) || (b2 && b2.length >= 4)) return false;
    if (!b1) { b1 = []; bondGraph.set(p1, b1); }
    if (!b2) { b2 = []; bondGraph.set(p2, b2); }
    b1.push({ target: p2, type, breakTemp }); b2.push({ target: p1, type, breakTemp });
    totalBondEdges++; p1.temp += 18; p2.temp += 18;
    return true;
  }

  function breakBond(p1, p2, endo = true) {
    let rem = false;
    for (const [a, b] of [[p1, p2], [p2, p1]]) {
      const arr = bondGraph.get(a);
      if (!arr) continue;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].target === b) { arr.splice(i, 1); rem = true; }
      if (!arr.length) bondGraph.delete(a);
    }
    if (rem) {
      totalBondEdges = Math.max(0, totalBondEdges - 1);
      if (endo) { if (p1 && !p1.del) p1.temp = Math.max(-273, p1.temp - 25); if (p2 && !p2.del) p2.temp = Math.max(-273, p2.temp - 25); }
    }
  }

  function breakAllBonds(p) { const arr = bondGraph.get(p); if (arr) for (const b of arr.slice()) breakBond(p, b.target, false); }
  function clearAllBonds() { bondGraph.clear(); totalBondEdges = 0; }

  const IMMOBILE_SET = new Set(["gravity_well", "star_gravity", "neutronium", "black_hole_core", "field_visualizer"]);
  function isImmobile(name) {
    const el = elements[name];
    if (!el || IMMOBILE_SET.has(name) || el.movable === false || el.behavior === behaviors.WALL) return true;
    return (typeof el.tick === "function" && el.tick.name === "WALL") || (typeof el.tick2 === "function" && el.tick2.name === "WALL");
  }

  function stepToward(m, tx, ty) {
    if (!m || m.del || isImmobile(m.element)) return false;
    const dx = Math.sign(tx - m.x), dy = Math.sign(ty - m.y);
    if (!dx && !dy) return false;
    for (const [nx, ny] of [[m.x + dx, m.y + dy], [m.x + dx, m.y], [m.x, m.y + dy]]) {
      if (!inSafeBounds(nx, ny)) continue;
      if (isEmpty(nx, ny)) { movePixel(m, nx, ny); return true; }
      const occ = pixelMap[nx][ny];
      if (occ && !occ.del && !isImmobile(occ.element) && (elements[occ.element]?.state === "gas" || elements[occ.element]?.state === "liquid")) return safeSwap(m, occ);
    }
    return false;
  }

  function updateBondsTick() {
    if (bondGraph.size > 0) {
      for (const p of Array.from(bondGraph.keys())) {
        const pb = bondGraph.get(p);
        if (!p || p.del || !pb?.length || !inSafeBounds(p.x, p.y) || pixelMap[p.x][p.y] !== p) { breakAllBonds(p); bondGraph.delete(p); continue; }
        let hitBrk = false, hitRad = false, hitWat = false;
        for (let c = 0; c < 8; c++) {
          const ax = p.x + DIRS[c][0], ay = p.y + DIRS[c][1];
          if (!inSafeBounds(ax, ay)) continue;
          const adj = pixelMap[ax][ay];
          if (!adj || adj.del) continue;
          if (adj.element === "bond_breaker") hitBrk = true;
          else if (RAD_AGENTS.has(adj.element)) hitRad = true;
          else if (adj.element === "water") hitWat = true;
        }
        if (hitBrk) { breakAllBonds(p); continue; }
        for (let j = pb.length - 1; j >= 0; j--) {
          const b = pb[j], t = b.target;
          if (!t || t.del || !inSafeBounds(t.x, t.y) || pixelMap[t.x][t.y] !== t) { breakBond(p, t, false); continue; }
          const dist = Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y));
          if (dist > 3 || p.temp > b.breakTemp || t.temp > b.breakTemp || ((p.charge > 0 || t.charge > 0) && (b.type !== "covalent" || Math.random() < 0.3)) || (hitRad && Math.random() < 0.25) || (b.type === "ionic" && hitWat && Math.random() < 0.1)) {
            breakBond(p, t, true); continue;
          }
          const avgT = (p.temp + t.temp) * 0.5; p.temp += (avgT - p.temp) * 0.2; t.temp += (avgT - t.temp) * 0.2;
          if (!isImmobile(p.element) && !isImmobile(t.element)) {
            const avx = ((p.vx || 0) + (t.vx || 0)) * 0.5, avy = ((p.vy || 0) + (t.vy || 0)) * 0.5;
            if (avx || avy) {
              p.vx = (p.vx || 0) + (avx - (p.vx || 0)) * 0.4; p.vy = (p.vy || 0) + (avy - (p.vy || 0)) * 0.4;
              t.vx = (t.vx || 0) + (avx - (t.vx || 0)) * 0.4; t.vy = (t.vy || 0) + (avy - (t.vy || 0)) * 0.4;
            }
          }
          if (dist > 1) {
            const pD = elements[p.element]?.density || 1000, tD = elements[t.element]?.density || 1000;
            if (!isImmobile(p.element) && (isImmobile(t.element) || pD <= tD)) stepToward(p, t.x, t.y); else stepToward(t, p.x, p.y);
          }
        }
      }
    }
    if (UPC_CONFIG.autoBonding && totalBondEdges < MAX_BONDS && currentPixels?.length) {
      for (let s = 0, lim = Math.min(45, currentPixels.length); s < lim && totalBondEdges < MAX_BONDS; s++) {
        const p = currentPixels[Math.floor(Math.random() * currentPixels.length)];
        if (!p || p.del || getBondCount(p) >= 3) continue;
        const d = randomDir(), nx = p.x + d[0], ny = p.y + d[1];
        if (!inSafeBounds(nx, ny)) continue;
        const q = pixelMap[nx][ny];
        if (!q || q.del || getBondCount(q) >= 3) continue;
        const rule = BOND_RULES[p.element < q.element ? p.element + "|" + q.element : q.element + "|" + p.element];
        if (!rule) continue;
        const avgT = (p.temp + q.temp) * 0.5;
        if (avgT < rule.lo || avgT > rule.hi) continue;
        const fa = p.element <= q.element;
        if (getBondCount(p) >= (fa ? rule.a : rule.b) || getBondCount(q) >= (fa ? rule.b : rule.a)) continue;
        if (Math.random() < rule.pr) createBond(p, q, rule.t, rule.bt);
      }
    }
    UPC_STATS.activeBonds = totalBondEdges;
  }

  function getDrawCtx() {
    if (typeof ctx !== "undefined" && ctx) return ctx;
    return typeof document !== "undefined" ? document.getElementById("game")?.getContext("2d") || null : null;
  }

  function drawActiveBonds() {
    const c2d = getDrawCtx(), ps = Number(typeof pixelSize !== "undefined" ? pixelSize : 0);
    if (!UPC_CONFIG.showBonds || !bondGraph.size || !c2d || !ps || Number.isNaN(ps)) return;
    c2d.save(); c2d.lineWidth = Math.max(1, ps * 0.26); c2d.lineCap = "round";
    bondGraph.forEach((bonds, p) => {
      if (!p || p.del) return;
      for (const b of bonds) {
        const t = b.target;
        if (!t || t.del || p.x > t.x || (p.x === t.x && p.y >= t.y)) continue;
        c2d.strokeStyle = b.type === "ionic" ? "rgba(255,215,90,.88)" : b.type === "polar" ? "rgba(110,225,255,.88)" : b.type === "catalyst" ? "rgba(140,255,130,.92)" : "rgba(255,255,255,.82)";
        c2d.beginPath(); c2d.moveTo((p.x + 0.5) * ps, (p.y + 0.5) * ps); c2d.lineTo((t.x + 0.5) * ps, (t.y + 0.5) * ps); c2d.stroke();
      }
    });
    c2d.restore();
  }

  // ---------------------------------------------------------------------------
  // 4. CIC GRAVITY & MAGNETS + THERMOSTAT EQUILIBRIUM + EMERGENT CORE BOUNCE
  // ---------------------------------------------------------------------------

  const IRON_CORE_SET = new Set(["iron", "molten_iron", "iron_gas", "nickel_56", "molten_nickel_56", "nickel_56_gas", "cobalt_56", "molten_cobalt_56", "cobalt_56_gas"]);
  const SUPER_R_TARGETS = new Set(["iron", "molten_iron", "iron_gas", "nickel", "molten_nickel", "nickel_gas", "cobalt", "molten_cobalt", "silicon_gas", "oxygen"]);
  const R_PRODUCTS = ["gold", "platinum", "lead", "thorium_232", "uranium_238", "uranium_235", "plutonium_239"];
  const STELLAR_MASS = { hydrogen: 0.50, deuterium: 0.58, tritium: 0.64, helium_3: 0.66, helium: 0.74, carbon_vapor: 0.96, oxygen: 1.12, neon: 1.18, magnesium_gas: 1.28, silicon_gas: 1.48, nickel_56_gas: 2.05, cobalt_56_gas: 2.05, iron_gas: 2.15, neutronium: 3.0 };
  const FERRO_CURIE = { iron: 770, molten_iron: 770, iron_filings: 770, steel: 750, cobalt: 1115, cobalt_60: 1115, nickel: 358, neodymium: 310, gadolinium: 20, rust: 580, metal_scrap: 750 };
  const MAG_POLE = { magnet_north: 1, magnet_south: -1, neodymium_north: 1, neodymium_south: -1, electromagnet_north: 1, electromagnet_south: -1, magnet_bead_n: 1, magnet_bead_s: -1 };
  const MAG_STR = { magnet_north: 1.0, magnet_south: -1.0, neodymium_north: 2.2, neodymium_south: -2.2, electromagnet_north: 1.9, electromagnet_south: -1.9, magnet_bead_n: 0.45, magnet_bead_s: -0.45 };
  const PLASMA_SET = new Set(["plasma", "hydrogen", "deuterium", "tritium", "helium", "helium_3", "carbon_vapor", "oxygen", "neon", "silicon_gas"]);
  const VEL_EXEMPT = new Set(["fast_neutron", "thermal_neutron", "radiation", "alpha_particle", "beta_particle", "gamma_ray", "bond_breaker", "bond_catalyst"]);

  const ELEM_COMP = {
    diamond: 0.005, osmium: 0.01, tungsten: 0.015, boron: 0.015, hafnium: 0.02, platinum: 0.02, steel: 0.025,
    iron: 0.03, cobalt: 0.03, nickel: 0.03, silicon: 0.03, uranium: 0.03, uranium_235: 0.03, uranium_238: 0.03,
    thorium_232: 0.03, beryllium: 0.03, glass: 0.03, plutonium_239: 0.035, copper: 0.035, gold: 0.035,
    stone: 0.04, concrete: 0.04, lead: 0.05, bismuth: 0.05, graphite: 0.05, alumina: 0.05, gallium: 0.06,
    ice: 0.07, heavy_ice: 0.07, iron_filings: 0.08, sand: 0.10, salt: 0.10, cesium: 0.11, rubidium: 0.11,
    rust: 0.12, dirt: 0.15, ash: 0.20, sawdust: 0.24, snow: 0.34, neutronium: 0.02,
    water: 0.001, heavy_water: 0.001, oil: 0.0015, lava: 0.001, mercury: 0.0008,
    hydrogen: 1.0, plasma: 1.0, deuterium: 0.98, tritium: 0.96, helium_3: 0.95, helium: 0.94,
    oxygen: 0.88, nitrogen: 0.88, neon: 0.86, steam: 0.86, heavy_steam: 0.85, ammonia: 0.86,
    carbon_vapor: 0.85, carbon_dioxide: 0.84, argon: 0.82, magnesium_gas: 0.82, silicon_gas: 0.80,
    iron_gas: 0.75, nickel_56_gas: 0.75, cobalt_56_gas: 0.75
  };

  function getBaseMass(name) {
    if (STELLAR_MASS[name] !== undefined) return STELLAR_MASS[name];
    return Math.min(5.0, Math.max(0.45, Math.pow((elements[name]?.density || 100) / 250, 0.45)));
  }

  function getVoxelMass(p) {
    if (!p) return 0;
    if (p.element === "black_hole_core") { if (!p.bhMass) p.bhMass = UPC_CONFIG.minBhMass; return p.bhMass; }
    return getBaseMass(p.element) * Math.max(1, p.pack || 1);
  }

  function getWallPack(name) {
    if (name === "neutronium") return 16;
    const el = elements[name], st = el?.state || "solid";
    if (st === "liquid") return 1.5;
    if (st === "gas" || st === "energy") return 10;
    const hard = el?.hardness !== undefined ? el.hardness : 0.65;
    return (el?.behavior === behaviors.POWDER || el?.category === "powders" || hard < 0.35) ? 6 : 4;
  }

  function getCompressibility(p) {
    const name = typeof p === "string" ? p : p.element;
    const pk = typeof p === "string" ? 1 : Math.max(1, p.pack || 1);
    const temp = typeof p === "string" ? 20 : (p.temp ?? 20);
    const el = elements[name], st = el?.state || "solid", dens = Math.max(0.05, el?.density || 1000);

    let base;
    if (ELEM_COMP[name] !== undefined) {
      base = ELEM_COMP[name];
    } else if (st === "liquid") {
      const boil = el?.tempHigh || 100;
      base = 0.001 + (temp > boil - 40 ? Math.max(0, Math.min(1, (temp - (boil - 40)) / 40)) * 0.002 : 0);
    } else if (st === "gas" || st === "energy") {
      base = Math.max(0.55, Math.min(1.0, 1.02 - Math.log10(dens + 1) * 0.14));
    } else {
      const hard = el?.hardness !== undefined ? el.hardness : 0.65;
      const isPow = el?.behavior === behaviors.POWDER || el?.category === "powders" || hard < 0.35;
      base = Math.max(0.008, Math.min(0.32, (isPow ? 0.34 : 0.10) * (1 / (1 + Math.pow(dens / 1800, 0.65))) * (1.15 - hard * 0.7)));
    }

    if (st === "solid") {
      const melt = el?.tempHigh || 1200;
      base *= (1 + Math.max(-0.5, Math.min(1.0, (temp - 20) / Math.max(200, melt))) * 0.30);
    } else if (st === "gas") {
      base /= (1 + Math.max(0, temp) / 95000);
    }

    const wall = getWallPack(name);
    let eff = base / Math.pow(pk, 0.72);
    if (pk >= wall) eff *= 0.055 / (1 + (pk - wall) * 0.75);
    return eff;
  }

  const FIELD_SOFT_PX2 = 13.6, SELF_PHI_UNIT = 4 / Math.sqrt(FIELD_SOFT_PX2);
  let fieldMw = 0, fieldMh = 0, fieldKw = 0;
  let kernelX = null, kernelY = null, kernelPhi = null;
  let macroMass = null, macroGx = null, macroGy = null, macroPhi = null;
  let macroPole = null, macroMagAbs = null, macroBx = null, macroBy = null, macroMagPot = null, macroBmag = null, macroGradBx = null, macroGradBy = null;
  let lastFieldTick = -100, lastBounceTick = -100;
  let gravFieldActive = false, magFieldActive = false, starModeActive = false, visualizerActive = false, movingPixelsLastTick = 0;

  function isFerroNow(p) { const c = FERRO_CURIE[p.element]; return c !== undefined && (!UPC_CONFIG.curieDemagnetize || p.temp <= c); }

  function getGridDims() {
    const gw = (typeof pixelMap !== "undefined" && pixelMap && pixelMap.length) ? pixelMap.length : ((typeof width === "number" ? width : 100) + 1);
    const gh = (typeof pixelMap !== "undefined" && pixelMap && pixelMap[0] && pixelMap[0].length) ? pixelMap[0].length : ((typeof height === "number" ? height : 100) + 1);
    return [gw, gh];
  }

  function ensureFieldTables() {
    const [gw, gh] = getGridDims();
    if (gw < 2 || gh < 2) return false;
    const effBlock = Math.max(FIELD_BLOCK, Math.ceil(Math.max(gw, gh) / 56));
    const mw = Math.max(3, Math.ceil(gw / effBlock) + 1), mh = Math.max(3, Math.ceil(gh / effBlock) + 1);
    if (mw === fieldMw && mh === fieldMh && effBlock === activeFieldBlock && kernelX) return true;

    activeFieldBlock = effBlock; fieldMw = mw; fieldMh = mh; lastGridW = gw; lastGridH = gh;
    const kw = 2 * mw - 1, kh = 2 * mh - 1; fieldKw = kw;
    kernelX = new Float32Array(kw * kh); kernelY = new Float32Array(kw * kh); kernelPhi = new Float32Array(kw * kh);
    for (let dy = -(mh - 1); dy <= mh - 1; dy++) {
      const rowOff = (dy + mh - 1) * kw, dyPx = dy * effBlock;
      for (let dx = -(mw - 1); dx <= mw - 1; dx++) {
        const idx = rowOff + (dx + mw - 1), dxPx = dx * effBlock;
        const invR = 1 / Math.sqrt(dxPx * dxPx + dyPx * dyPx + FIELD_SOFT_PX2), invR3 = invR * invR * invR;
        kernelX[idx] = -16 * dxPx * invR3; kernelY[idx] = -16 * dyPx * invR3; kernelPhi[idx] = 4 * invR;
      }
    }
    const tot = mw * mh;
    macroMass = new Float32Array(tot); macroGx = new Float32Array(tot); macroGy = new Float32Array(tot); macroPhi = new Float32Array(tot);
    macroPole = new Float32Array(tot); macroMagAbs = new Float32Array(tot); macroBx = new Float32Array(tot);
    macroBy = new Float32Array(tot); macroMagPot = new Float32Array(tot); macroBmag = new Float32Array(tot);
    macroGradBx = new Float32Array(tot); macroGradBy = new Float32Array(tot);
    return true;
  }

  function depositCIC(arr, x, y, val) {
    const fx = x / activeFieldBlock, fy = y / activeFieldBlock;
    const x0 = Math.max(0, Math.min(fieldMw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(fieldMh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const ix = 1 - tx, iy = 1 - ty, r0 = y0 * fieldMw + x0, r1 = r0 + fieldMw;
    arr[r0] += val * ix * iy; arr[r0 + 1] += val * tx * iy; arr[r1] += val * ix * ty; arr[r1 + 1] += val * tx * ty;
  }

  function sampleField(arr, x, y) {
    if (!arr || fieldMw < 2 || fieldMh < 2) return 0;
    const fx = x / activeFieldBlock, fy = y / activeFieldBlock;
    const x0 = Math.max(0, Math.min(fieldMw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(fieldMh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const r0 = y0 * fieldMw + x0, r1 = r0 + fieldMw;
    const top = arr[r0] + (arr[r0 + 1] - arr[r0]) * tx, bot = arr[r1] + (arr[r1 + 1] - arr[r1]) * tx;
    return top + (bot - top) * ty;
  }

  // EOS Pressure: Bulk Stiffness + Degeneracy Wall + Thermal + Fusion Radiation + Bounce + Electric
  function computeEOSPressure(p) {
    const el = elements[p.element], st = el?.state || "solid", pk = p.pack || 1;
    const effComp = Math.max(0.0005, getCompressibility(p));
    const wall = getWallPack(p.element);
    const tempK = Math.max(100, p.temp + 273);
    const pElec = p.charge > 0 ? p.charge * 120 : 0;
    const pRad = (p.radEnergy || 0) * 6.5 + (p.temp > 16000 ? Math.pow((p.temp - 16000) / 14000, 1.8) * 14 * Math.pow(pk, 0.45) : 0);
    const pBounce = p.bounceTicks > 0 ? p.bounceTicks * 160 * Math.sqrt(pk) : 0;

    const wallResist = pk > wall
      ? (p.element === "neutronium" ? 900 : (st === "gas" ? 380 : 620)) * Math.pow(pk - wall + 0.5, 2.0)
      : 0;

    if (st === "liquid") return (pk > 1 ? 4200 * Math.pow(pk - 1, 1.8) : 0) + wallResist + tempK * 0.025 + pRad + pElec + pBounce;
    if (st === "solid") return (pk > 1 ? (160 / effComp) * Math.pow(pk - 1, 1.4) : 0) + wallResist + tempK * 0.015 + pRad + pElec + pBounce;
    return Math.pow(tempK, 0.78) * 0.048 * Math.pow(pk, 0.92) + wallResist + pRad + pElec + pBounce;
  }

  function mergeVoxelInto(keeper, absorbed, st) {
    if (!keeper || !absorbed || keeper === absorbed || keeper.del || absorbed.del) return false;
    if (keeper.element !== absorbed.element || isImmobile(absorbed.element) || st === "liquid") return false;
    const kp = keeper.pack || 1, ap = absorbed.pack || 1, npk = kp + ap;
    if (npk > MAX_PACK) return false;
    keeper.vx = ((keeper.vx || 0) * kp + (absorbed.vx || 0) * ap) / npk;
    keeper.vy = ((keeper.vy || 0) * kp + (absorbed.vy || 0) * ap) / npk;
    keeper.radEnergy = Math.min(380, Math.max(keeper.radEnergy || 0, absorbed.radEnergy || 0));
    let avgT = (keeper.temp * kp + absorbed.temp * ap) / npk;
    if (UPC_CONFIG.compressionHeatScale > 0) {
      const ratio = npk / kp, tempK = Math.max(200, avgT + 273);
      const mult = st === "gas" ? 1.0 : 0.35;
      avgT = Math.min(280000, avgT + (tempK * 0.50 * (ratio - 1) + 2400 * (ratio - 1) * Math.sqrt(npk)) * mult * UPC_CONFIG.compressionHeatScale);
    }
    keeper.temp = avgT;
    keeper.pack = +npk.toFixed(2);
    updatePackColor(keeper);
    breakAllBonds(absorbed); deletePixel(absorbed.x, absorbed.y);
    return true;
  }

  function splitPackedVoxel(p, ex, ey, st, bounceSpeed = 0) {
    if (!p || p.del || (p.pack || 1) < 2 || !inSafeBounds(ex, ey) || !isEmpty(ex, ey)) return false;
    const pk = p.pack || 1, half = Math.max(1, Math.floor(pk / 2)), rem = +(pk - half).toFixed(2);
    if (rem < 1) return false;
    const np = safeCreate(p.element, ex, ey);
    if (!np) return false;
    p.pack = rem; np.pack = half;
    let nt = p.temp;
    if (st === "gas" && UPC_CONFIG.compressionHeatScale > 0 && nt > 20 && !bounceSpeed) nt = Math.max(20, nt - (nt + 273) * 0.14 * UPC_CONFIG.compressionHeatScale);
    p.temp = nt; np.temp = nt;
    np.radEnergy = (p.radEnergy || 0) * 0.7;
    const kick = bounceSpeed || 0.7;
    np.vx = (p.vx || 0) + Math.sign(ex - p.x) * kick; np.vy = (p.vy || 0) + Math.sign(ey - p.y) * kick;
    if (bounceSpeed > 1.2) { np.ejectaTicks = 34; np.bounceTicks = Math.max(0, (p.bounceTicks || 0) - 2); }
    updatePackColor(p); updatePackColor(np);
    movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    return true;
  }

  function triggerCoreBounce(p, phiNet) {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    const pk = p.pack || 1, cx = p.x, cy = p.y, vMass = getVoxelMass(p);
    const sc = UPC_CONFIG.collapseThresholdScale;
    const isHotCore = p.temp >= NS_MIN_TEMP && (IRON_CORE_SET.has(p.element) || pk >= getWallPack(p.element) * 1.15);

    const bounceR = Math.min(20, Math.round(7 + Math.sqrt(pk) * 2.2));
    const power = Math.min(2.6, 0.85 + pk / 12);

    for (let dx = -bounceR; dx <= bounceR; dx++) for (let dy = -bounceR; dy <= bounceR; dy++) {
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > bounceR * bounceR) continue;
      const nx = cx + dx, ny = cy + dy;
      if (!inSafeBounds(nx, ny)) continue;
      const q = pixelMap[nx][ny];
      if (!q || q.del || IMMOBILE_SET.has(q.element)) continue;
      const dist = Math.sqrt(d2), falloff = 1 - dist / (bounceR + 2);
      const kick = Math.min(4.4, (2.2 + 12 * power / Math.max(2, dist)) * falloff);
      q.vx = (q.vx || 0) + (dx / dist) * kick;
      q.vy = (q.vy || 0) + (dy / dist) * kick;
      q.ejectaTicks = Math.max(q.ejectaTicks || 0, Math.round(28 + 14 * falloff));
      q.bounceTicks = Math.max(q.bounceTicks || 0, Math.round(12 * falloff));
      q.radEnergy = Math.min(380, (q.radEnergy || 0) + 130 * falloff);
      q.temp = Math.min(280000, q.temp + Math.round((28000 * power) / Math.max(2.5, dist)));
      if (q.temp > 60000 && SUPER_R_TARGETS.has(q.element) && Math.random() < (IRON_CORE_SET.has(q.element) ? 0.35 : 0.12)) {
        safeChange(q, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]);
      }
      movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }

    if (isHotCore && vMass >= 18 * sc && phiNet >= 150 * sc && p.element !== "neutronium") {
      safeChange(p, "neutronium");
      p.pack = Math.max(8, +(vMass * 0.45 / getBaseMass("neutronium")).toFixed(2));
      p.temp = Math.max(p.temp, 110000);
      spawnNeutronsAround(cx, cy, 24, "fast_neutron");
      spawnParticle(cx, cy, "gamma_ray", 8);
      if (t - lastBounceTick > 45) notifyUser("Core Bounce! Degeneracy rebound blasted star outward -> Neutron Star!", true);
    } else {
      p.bounceTicks = 18; p.radEnergy = 380; p.temp = Math.min(280000, p.temp + 25000);
      if (t - lastBounceTick > 45) notifyUser("Degeneracy Pressure Bounce! Compressed core rebounding outward!", true);
    }
    lastBounceTick = t;
  }

  function evaluateWallState(p, phiNet, pOverburden, myP) {
    if (!UPC_CONFIG.supernovaEnabled || !p || p.del || p.element === "black_hole_core") return false;
    const pk = p.pack || 1, sc = UPC_CONFIG.collapseThresholdScale;
    const wall = getWallPack(p.element), vMass = getVoxelMass(p), minBh = UPC_CONFIG.minBhMass * sc;

    const pastWall = pk >= wall * 1.2 && pk >= 5;
    const resistanceOvertaken = pOverburden > myP * 1.15;

    if (p.element === "neutronium") {
      if (vMass >= minBh && (resistanceOvertaken || vMass >= minBh * 1.4)) {
        safeChange(p, "black_hole_core");
        p.bhMass = +vMass.toFixed(1);
        spawnParticle(p.x, p.y, "gamma_ray", 8);
        notifyUser(`Neutron star crossed TOV limit -> Black Hole (${p.bhMass}M)!`, true);
        return true;
      }
      return false;
    }

    if (pastWall && vMass >= minBh && resistanceOvertaken) {
      const mSnap = +vMass.toFixed(1);
      safeChange(p, "black_hole_core"); p.bhMass = mSnap;
      triggerCoreBounce(p, phiNet);
      notifyUser(`Gravity overcame degeneracy wall -> Black Hole (${mSnap}M)!`, true);
      return true;
    }

    if (pk >= wall * 1.12 && !(p.bounceTicks > 0)) {
      const noFusionSupport = (p.radEnergy || 0) < 55 || IRON_CORE_SET.has(p.element);
      if (noFusionSupport || pk >= wall * 1.35) { triggerCoreBounce(p, phiNet); return true; }
    }
    return false;
  }

  function applyCompressionAndPressure(p, gx, gy, phiNet, mergeBudget) {
    const el = elements[p.element], st = el?.state || "solid", gMag = Math.hypot(gx, gy), pk = p.pack || 1;
    const effComp = getCompressibility(p), wall = getWallPack(p.element);

    if (p.bounceTicks > 0) p.bounceTicks--;

    if (p.radEnergy > 0.5) {
      const rd = randomDir(), rx = p.x + rd[0], ry = p.y + rd[1];
      if (inSafeBounds(rx, ry)) {
        const rnb = pixelMap[rx][ry];
        if (rnb && !rnb.del && (rnb.radEnergy || 0) < p.radEnergy) {
          const xfer = (p.radEnergy - (rnb.radEnergy || 0)) * 0.16;
          rnb.radEnergy = (rnb.radEnergy || 0) + xfer; p.radEnergy -= xfer;
        }
      }
      p.radEnergy *= 0.945; // Slower decay so steady Main Sequence fusion maintains smooth support
      if (p.radEnergy < 0.5) p.radEnergy = 0;
    }

    let surrounded = 0, emptyDx = 0, emptyDy = 0, emptyCount = 0, firstEX = -1, firstEY = -1, sameNb = null;
    let gradPx = 0, gradPy = 0;

    const myP = computeEOSPressure(p);
    p.pressure = Math.round(myP);

    const start = Math.floor(Math.random() * 8);
    for (let i = 0; i < 8; i++) {
      const d = DIRS[(start + i) & 7], cx = p.x + d[0], cy = p.y + d[1];
      if (!inSafeBounds(cx, cy)) { surrounded++; continue; }
      if (isEmpty(cx, cy)) {
        emptyDx += d[0]; emptyDy += d[1]; emptyCount++;
        if (firstEX === -1) { firstEX = cx; firstEY = cy; }
        gradPx -= myP * d[0] * 0.25; gradPy -= myP * d[1] * 0.25;
      } else {
        surrounded++;
        const nb = pixelMap[cx][cy];
        if (nb && !nb.del) {
          const nbP = nb.pressure || 0;
          gradPx += (nbP - myP) * d[0] * 0.25; gradPy += (nbP - myP) * d[1] * 0.25;
          if (!sameNb && nb.element === p.element && !isImmobile(nb.element) && (nb.pack || 1) + pk <= MAX_PACK) sameNb = nb;
        }
      }
    }

    let pax = 0, pay = 0;
    const pScale = UPC_CONFIG.pressureForceScale;
    if (pScale > 0 && (myP > 12 || gradPx || gradPy)) {
      const effMass = st === "gas" ? Math.max(1, pk * 0.55) : Math.max(3, pk * 2.0);
      const gain = (st === "gas" ? 0.00085 : 0.00040) * pScale / effMass;
      const pCap = (pk >= wall * 0.8 || p.bounceTicks > 0) ? 2.2 : 0.65;
      pax = Math.max(-pCap, Math.min(pCap, -gradPx * gain));
      pay = Math.max(-pCap, Math.min(pCap, -gradPy * gain));
    }

    const imp = p.inwardImpulse || 0;
    p.inwardImpulse = imp * 0.45;

    const densNorm = Math.min(3.0, Math.max(0.35, Math.sqrt((el?.density || 1000) / 1000)));
    const pOverburden = surrounded >= 5 && phiNet > 45
      ? (phiNet - 45) * (1.35 + Math.min(1.8, imp * 0.9) + Math.min(0.9, gMag * 0.045)) * (st === "gas" ? Math.sqrt(pk) : densNorm * 0.85)
      : 0;
    p.pGrav = Math.round(pOverburden);

    // THERMOSTAT SQUISH HEATING: ONLY heats when gravity actively beats internal pressure (pOverburden > myP)!
    // Drops to ZERO during hydrostatic equilibrium so Main Sequence stars stay stably balanced!
    if (pk > 1.15 && pOverburden > myP * 1.02 && UPC_CONFIG.compressionHeatScale > 0) {
      const imbalance = Math.min(1.0, (pOverburden - myP) / Math.max(40, pOverburden));
      const squishRatio = Math.min(4.0, (pk - 1) / Math.max(1, wall * 0.5));
      const squishHeat = (Math.pow(squishRatio, 1.8) * Math.min(3.5, pOverburden / 140) * 180 + imp * pk * 60) * imbalance * UPC_CONFIG.compressionHeatScale;
      p.temp = Math.min(280000, p.temp + squishHeat);
    }

    // Nonlinear Stefan-Boltzmann-style stellar radiative cooling (stabilizes Main Sequence luminosity!)
    if (st === "gas" && UPC_CONFIG.radiativeCooling && starModeActive && p.temp > 2500) {
      const tScale = Math.min(3.5, Math.pow(p.temp / 25000, 0.45));
      p.temp = Math.max(20, p.temp - (p.temp - 2500) * (surrounded < 6 ? 0.0085 : 0.0024) * tScale);
    }

    if (st === "solid") {
      if (p.element === "graphite" && (pOverburden > 300 || myP > 300) && p.temp >= 1200 && elements.diamond) { safeChange(p, "diamond"); return { pax, pay }; }
      if (p.element === "ice" && (pOverburden > 380 || myP > 380) && elements.water) { safeChange(p, "water"); return { pax, pay }; }
      if (pOverburden > 850 && (el?.hardness ?? 0.7) < 0.55 && p.element === "stone" && elements.sand && Math.random() < 0.02) { safeChange(p, "sand"); return { pax, pay }; }
    } else if (st === "liquid" && imp > 0.12 && emptyCount > 0 && gMag > 0.08) {
      const tx = -gy / gMag, ty = gx / gMag, sign = (tx * emptyDx + ty * emptyDy) >= 0 ? 1 : -1, flow = Math.min(0.8, imp * 0.5);
      pax += tx * sign * flow * 0.4; pay += ty * sign * flow * 0.4;
    }

    if (st !== "liquid" && !(p.bounceTicks > 0) && effComp > 0.0002 && surrounded >= 5 && sameNb && mergeBudget.left > 0) {
      const minPhi = st === "gas" ? 45 : 220;
      const bulkGate = st === "solid" ? (150 / Math.max(0.005, effComp)) * 0.45 : 0;
      const effResist = Math.max(myP * 1.12, bulkGate);

      if (phiNet >= minPhi && pOverburden > effResist) {
        const excess = Math.min(1.5, (pOverburden - effResist) / Math.max(50, pOverburden));
        const ironBoost = IRON_CORE_SET.has(p.element) ? 2.8 : 1.0;
        const prob = Math.min(0.22, (0.012 + Math.min(0.042, imp * 0.028)) * Math.min(1, effComp * 1.7) * excess * ironBoost);
        if (Math.random() < prob && mergeVoxelInto(p, sameNb, st)) {
          mergeBudget.left--;
          evaluateWallState(p, phiNet, pOverburden, computeEOSPressure(p));
          return { pax, pay };
        }
      }
    }

    if (pk >= 2 && firstEX !== -1 && (surrounded < 5 || p.bounceTicks > 0 || myP > pOverburden * 1.08)) {
      const bouncing = p.bounceTicks > 0 || pk >= wall;
      const splitProb = bouncing ? 0.65 : (surrounded < 5 ? 0.28 : Math.min(0.24, 0.04 + ((myP - pOverburden) / Math.max(60, myP)) * 0.18));
      if (Math.random() < splitProb) {
        splitPackedVoxel(p, firstEX, firstEY, st, bouncing ? 2.6 : 0.75);
        return { pax, pay };
      }
    }

    if (pk >= wall) evaluateWallState(p, phiNet, pOverburden, myP);
    updatePackColor(p);
    return { pax, pay };
  }

  function drawBlackHoleAurasAndRadGlow() {
    const c2d = getDrawCtx(), ps = Number(typeof pixelSize !== "undefined" ? pixelSize : 0);
    if (!c2d || !ps || Number.isNaN(ps) || !currentPixels?.length) return;
    const bhClusters = [];

    if (UPC_CONFIG.showPackGlow) {
      c2d.save();
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del) continue;
        if (p.element === "black_hole_core") {
          const m = getVoxelMass(p);
          let found = null;
          for (const cl of bhClusters) if (Math.abs(p.x - cl.cx) <= 10 && Math.abs(p.y - cl.cy) <= 10) { found = cl; break; }
          if (found) {
            found.mass += m; found.sx += p.x; found.sy += p.y; found.cnt++;
            found.cx = found.sx / found.cnt; found.cy = found.sy / found.cnt;
            if (p.y < found.minY) found.minY = p.y;
          } else bhClusters.push({ cx: p.x, cy: p.y, sx: p.x, sy: p.y, minY: p.y, cnt: 1, mass: m });
        } else if (p.radEnergy > 18 && (p.pack || 1) <= 1.05) {
          c2d.fillStyle = `rgba(255,246,175,${Math.min(0.45, p.radEnergy / 360).toFixed(2)})`;
          c2d.fillRect(p.x * ps, p.y * ps, ps, ps);
        }
      }
      c2d.restore();
    } else {
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del || p.element !== "black_hole_core") continue;
        const m = getVoxelMass(p);
        let found = null;
        for (const cl of bhClusters) if (Math.abs(p.x - cl.cx) <= 10 && Math.abs(p.y - cl.cy) <= 10) { found = cl; break; }
        if (found) { found.mass += m; found.sx += p.x; found.sy += p.y; found.cnt++; found.cx = found.sx / found.cnt; found.cy = found.sy / found.cnt; if (p.y < found.minY) found.minY = p.y; }
        else bhClusters.push({ cx: p.x, cy: p.y, sx: p.x, sy: p.y, minY: p.y, cnt: 1, mass: m });
      }
    }

    if (bhClusters.length) {
      c2d.save();
      c2d.font = `700 ${Math.max(10, Math.round(ps * 2.1))}px ui-monospace, Consolas, monospace`;
      c2d.textAlign = "center"; c2d.textBaseline = "bottom";
      for (const cl of bhClusters) {
        const px = (cl.cx + 0.5) * ps, py = (cl.cy + 0.5) * ps;
        const ringR = Math.max(ps * 1.8, (1.5 + Math.log2(Math.max(2, cl.mass)) * 0.45) * ps);
        c2d.strokeStyle = "rgba(185,110,255,0.75)"; c2d.lineWidth = Math.max(1.5, ps * 0.35);
        c2d.beginPath(); c2d.arc(px, py, ringR, 0, Math.PI * 2); c2d.stroke();
        const txt = `BH ${Math.round(cl.mass)}M`, ly = Math.max(14, (cl.minY - 0.8) * ps - 4), tw = c2d.measureText(txt).width;
        c2d.fillStyle = "rgba(12,6,22,0.82)"; c2d.fillRect(px - tw * 0.5 - 4, ly - 13, tw + 8, 14);
        c2d.fillStyle = "#e2b8ff"; c2d.fillText(txt, px, ly);
      }
      c2d.restore();
    }
  }

  function rebuildFields() {
    if (!ensureFieldTables()) return;
    macroMass.fill(0); macroGx.fill(0); macroGy.fill(0); macroPhi.fill(0);
    macroPole.fill(0); macroMagAbs.fill(0); macroBx.fill(0); macroBy.fill(0); macroMagPot.fill(0);

    let hasStar = false, hasWell = false, hasMag = false, hasVis = false, peakPack = 1, totalBhM = 0, comM = 0, comX = 0, comY = 0;
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del) continue;
      const e = p.element, pk = p.pack || 1;
      if (pk > peakPack) peakPack = pk;
      if (e === "star_gravity") { hasStar = true; continue; }
      if (e === "field_visualizer") { hasVis = true; continue; }

      const ms = MAG_STR[e];
      if (ms !== undefined && ((e !== "electromagnet_north" && e !== "electromagnet_south") || p.charge > 0)) {
        depositCIC(macroPole, p.x, p.y, ms); depositCIC(macroMagAbs, p.x, p.y, Math.abs(ms)); hasMag = true;
      }

      if (e === "gravity_well") { hasWell = true; depositCIC(macroMass, p.x, p.y, 48); comM += 48; comX += p.x * 48; comY += p.y * 48; }
      else if (e === "neutronium" || e === "black_hole_core") {
        const m = getVoxelMass(p);
        if (e === "black_hole_core") totalBhM += m;
        hasWell = true; depositCIC(macroMass, p.x, p.y, m); comM += m; comX += p.x * m; comY += p.y * m;
      } else if (!isImmobile(e)) {
        const m = getVoxelMass(p);
        depositCIC(macroMass, p.x, p.y, m); comM += m; comX += p.x * m; comY += p.y * m;
      }
    }
    UPC_STATS.maxPack = peakPack;
    UPC_STATS.totalBhMass = Math.round(totalBhM);

    const mode = UPC_CONFIG.gravityMethod;
    if (mode === "off") { hasStar = false; hasWell = false; macroMass.fill(0); }
    else if (mode === "star") hasStar = true;
    else if (mode === "wells_only") hasStar = false;
    else if (mode === "com") {
      macroMass.fill(0);
      if (comM > 0) depositCIC(macroMass, comX / comM, comY / comM, comM);
      hasStar = true;
    }

    starModeActive = hasStar;
    gravFieldActive = (hasStar || hasWell) && GRAV_ACCEL > 0;
    magFieldActive = hasMag && MAG_POLE_ACCEL > 0;
    visualizerActive = hasVis || !!UPC_CONFIG.showFields;

    if (mode !== "off" && mode !== "com" && !hasStar && hasWell) {
      macroMass.fill(0);
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del) continue;
        if (p.element === "gravity_well") depositCIC(macroMass, p.x, p.y, 48);
        else if (p.element === "neutronium" || p.element === "black_hole_core") depositCIC(macroMass, p.x, p.y, getVoxelMass(p));
      }
    }

    UPC_STATS.activeGravTiles = 0; UPC_STATS.activeMagTiles = 0;
    if (!gravFieldActive && !magFieldActive) return;

    const mw = fieldMw, mh = fieldMh, kw = fieldKw;
    for (let sy = 0; sy < mh; sy++) {
      for (let sx = 0; sx < mw; sx++) {
        const sIdx = sy * mw + sx;
        const m = gravFieldActive ? macroMass[sIdx] : 0, q = magFieldActive ? macroPole[sIdx] : 0, qA = magFieldActive ? macroMagAbs[sIdx] : 0;
        if (m > 0.001) UPC_STATS.activeGravTiles++;
        if (qA > 0.001) UPC_STATS.activeMagTiles++;
        if (m <= 0.001 && Math.abs(q) <= 0.001 && qA <= 0.001) continue;
        const kxBase = mw - 1 - sx;
        for (let ty = 0; ty < mh; ty++) {
          let gIdx = ty * mw, kIdx = (ty - sy + mh - 1) * kw + kxBase;
          if (m > 0.001 && qA > 0.001) {
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              const kx = kernelX[kIdx], ky = kernelY[kIdx], kp = kernelPhi[kIdx];
              macroGx[gIdx] += m * kx; macroGy[gIdx] += m * ky; macroPhi[gIdx] += m * kp;
              macroBx[gIdx] -= q * kx; macroBy[gIdx] -= q * ky; macroMagPot[gIdx] += qA * kp;
            }
          } else if (m > 0.001) {
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) { macroGx[gIdx] += m * kernelX[kIdx]; macroGy[gIdx] += m * kernelY[kIdx]; macroPhi[gIdx] += m * kernelPhi[kIdx]; }
          } else {
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) { macroBx[gIdx] -= q * kernelX[kIdx]; macroBy[gIdx] -= q * kernelY[kIdx]; macroMagPot[gIdx] += qA * kernelPhi[kIdx]; }
          }
        }
      }
    }

    if (magFieldActive) {
      const tot = mw * mh, gs = 2 / activeFieldBlock;
      for (let i = 0; i < tot; i++) macroBmag[i] = Math.hypot(macroBx[i], macroBy[i]) + 0.25 * macroMagPot[i];
      for (let by = 0; by < mh; by++) {
        const row = by * mw, yP = by > 0 ? (by - 1) * mw : row, yN = by < mh - 1 ? (by + 1) * mw : row;
        for (let bx = 0; bx < mw; bx++) {
          macroGradBx[row + bx] = (macroBmag[row + (bx < mw - 1 ? bx + 1 : bx)] - macroBmag[row + (bx > 0 ? bx - 1 : bx)]) * gs;
          macroGradBy[row + bx] = (macroBmag[yN + bx] - macroBmag[yP + bx]) * gs;
        }
      }
    }
  }

  function advancePixelByVelocity(p) {
    let remX = Math.trunc(p.rx), remY = Math.trunc(p.ry);
    if (!remX && !remY) return;
    p.rx -= remX; p.ry -= remY;
    const steps = Math.min(p.ejectaTicks > 0 ? 4 : 3, Math.max(Math.abs(remX), Math.abs(remY)));
    const pEl = elements[p.element], pDens = (pEl?.density || 1000) * (p.pack || 1), pSt = pEl?.state || "solid";

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
      const spd = Math.hypot(p.vx || 0, p.vy || 0);

      if (target.element === "neutronium" && gravFieldActive && spd > 0.65 && (p.freeSteps || 0) >= 1) {
        target.pack = +((target.pack || 10) + getVoxelMass(p) / getBaseMass("neutronium")).toFixed(2);
        target.temp = Math.min(280000, target.temp + 600);
        breakAllBonds(p); deletePixel(p.x, p.y);
        const phiN = sampleField(macroPhi, target.x, target.y);
        evaluateWallState(target, phiN, Math.max(0, (phiN - 45) * 1.6), computeEOSPressure(target));
        return;
      }

      if (!isImmobile(target.element)) {
        const tInfo = elements[target.element], tDens = (tInfo?.density || 1000) * (target.pack || 1), tSt = tInfo?.state || "solid";
        if ((tSt === "gas" || tSt === "liquid") && pDens > tDens * 1.15 && !(p.ejectaTicks > 0)) { safeSwap(p, target); p.vx *= 0.88; p.vy *= 0.88; p.freeSteps = 0; remX -= sx; remY -= sy; continue; }
        const tvx = target.vx || 0, tvy = target.vy || 0, relSpd = Math.hypot(p.vx - tvx, p.vy - tvy), impAdd = Math.min(1.6, relSpd * 0.7);
        p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + impAdd);
        target.inwardImpulse = Math.min(4.0, (target.inwardImpulse || 0) + impAdd * 0.85);
        if ((p.freeSteps || 0) >= 2 && relSpd > 1.55) { const h = Math.min(220, Math.round((relSpd - 1.45) * 34)); p.temp += h; target.temp += h; }

        if (p.ejectaTicks > 4 && relSpd > 1.2) {
          target.ejectaTicks = Math.max(target.ejectaTicks || 0, p.ejectaTicks - 2);
          target.radEnergy = Math.min(380, (target.radEnergy || 0) + 35);
          target.temp = Math.min(280000, target.temp + Math.round(relSpd * 1800));
          if (target.temp > 60000 && SUPER_R_TARGETS.has(target.element) && Math.random() < 0.16) {
            safeChange(target, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]);
          }
        }

        p.freeSteps = 0; target.freeSteps = 0;
        if (pSt === "solid" && tSt === "solid" && relSpd < 0.9 && !(p.ejectaTicks > 0)) { if (sx) { p.vx = 0; p.rx = 0; } if (sy) { p.vy = 0; p.ry = 0; } }
        else {
          const tot = pDens + tDens, nvx = (pDens * p.vx + tDens * tvx) / tot, nvy = (pDens * p.vy + tDens * tvy) / tot;
          const damp = (p.ejectaTicks > 0) ? 0.92 : ((pSt === "solid" && tSt === "solid") ? 0.55 : 0.82);
          const xfer = (p.ejectaTicks > 0) ? 1.25 : 1.05;
          p.vx = nvx * damp; p.vy = nvy * damp;
          const cap = target.ejectaTicks > 0 ? MAX_SPEED * 1.8 : MAX_SPEED;
          target.vx = Math.max(-cap, Math.min(cap, tvx + (nvx - tvx) * xfer));
          target.vy = Math.max(-cap, Math.min(cap, tvy + (nvy - tvy) * xfer));
        }
        break;
      } else {
        p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + spd * 0.6);
        if ((p.freeSteps || 0) >= 2 && spd > 1.65) p.temp += Math.min(140, Math.round((spd - 1.55) * 24));
        p.freeSteps = 0;
        if (sx) { p.vx = Math.abs(p.vx) > 1.2 ? -p.vx * 0.25 : 0; p.rx = 0; }
        if (sy) { p.vy = Math.abs(p.vy) > 1.2 ? -p.vy * 0.25 : 0; p.ry = 0; }
        p.vx *= 0.85; p.vy *= 0.85; break;
      }
    }
  }

  function updateGravityAndCompressionTick() {
    if (!currentPixels?.length) return;
    const [gw, gh] = getGridDims();
    const resized = gw !== lastGridW || gh !== lastGridH;
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (resized || t - lastFieldTick >= FIELD_REBUILD_INTERVAL) { lastFieldTick = t; rebuildFields(); }

    const hasPressure = UPC_CONFIG.pressureForceScale > 0 && (gravFieldActive || UPC_STATS.maxPack >= 2);
    if (!gravFieldActive && !magFieldActive && !hasPressure && movingPixelsLastTick === 0) { UPC_STATS.movingPixels = 0; return; }

    const doComp = (t & 1) === 0, mergeBudget = { left: 18 };
    let movingNow = 0;
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del || isImmobile(p.element) || VEL_EXEMPT.has(p.element)) continue;

      let ax = 0, ay = 0, gx = 0, gy = 0;
      if (gravFieldActive) { gx = sampleField(macroGx, p.x, p.y); gy = sampleField(macroGy, p.x, p.y); ax += gx * GRAV_ACCEL; ay += gy * GRAV_ACCEL; }

      if (magFieldActive) {
        const pole = MAG_POLE[p.element];
        if (pole !== undefined) { ax += pole * sampleField(macroBx, p.x, p.y) * MAG_POLE_ACCEL; ay += pole * sampleField(macroBy, p.x, p.y) * MAG_POLE_ACCEL; }
        else if (isFerroNow(p)) { ax += sampleField(macroGradBx, p.x, p.y) * MAG_FERRO_ACCEL; ay += sampleField(macroGradBy, p.x, p.y) * MAG_FERRO_ACCEL; }
        else if (p.element === "superconductor" && p.temp <= -180) { ax -= sampleField(macroGradBx, p.x, p.y) * MAG_MEISSNER_ACCEL; ay -= sampleField(macroGradBy, p.x, p.y) * MAG_MEISSNER_ACCEL; }
        else if (p.element === "bismuth") { ax -= sampleField(macroGradBx, p.x, p.y) * MAG_DIAMAG_ACCEL; ay -= sampleField(macroGradBy, p.x, p.y) * MAG_DIAMAG_ACCEL; }
        else if (UPC_CONFIG.plasmaConfinement && p.temp >= 6000 && PLASMA_SET.has(p.element)) { ax -= sampleField(macroGradBx, p.x, p.y) * MAG_PLASMA_ACCEL; ay -= sampleField(macroGradBy, p.x, p.y) * MAG_PLASMA_ACCEL; }
      }

      if (doComp) {
        const selfM = (starModeActive && UPC_CONFIG.gravityMethod !== "com") ? getVoxelMass(p) : 0;
        const phiNet = gravFieldActive ? Math.max(0, sampleField(macroPhi, p.x, p.y) - selfM * SELF_PHI_UNIT) : 0;
        const pf = applyCompressionAndPressure(p, gx, gy, phiNet, mergeBudget);
        if (p.del) continue;
        p.pax = pf.pax; p.pay = pf.pay;
      }
      if (p.pax) ax += p.pax;
      if (p.pay) ay += p.pay;

      const pEl = elements[p.element];
      if ((pEl?.state || "solid") === "solid" && !(p.ejectaTicks > 0)) {
        const pDens = (pEl?.density || 1000) * (p.pack || 1);
        if (ax) {
          const sx = Math.sign(ax), nx = p.x + sx, nb = inSafeBounds(nx, p.y) ? pixelMap[nx][p.y] : null;
          if (!inSafeBounds(nx, p.y) || (nb && (isImmobile(nb.element) || ((elements[nb.element]?.state || "solid") === "solid" && ((elements[nb.element]?.density || 1000) * (nb.pack || 1)) >= pDens * 0.85 && (nb.vx || 0) * sx <= 0.15)))) {
            p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + Math.abs(ax)); ax = 0; if (Math.sign(p.vx || 0) === sx) { p.vx = 0; p.rx = 0; } p.freeSteps = 0;
          }
        }
        if (ay) {
          const sy = Math.sign(ay), ny = p.y + sy, nb = inSafeBounds(p.x, ny) ? pixelMap[p.x][ny] : null;
          if (!inSafeBounds(p.x, ny) || (nb && (isImmobile(nb.element) || ((elements[nb.element]?.state || "solid") === "solid" && ((elements[nb.element]?.density || 1000) * (nb.pack || 1)) >= pDens * 0.85 && (nb.vy || 0) * sy <= 0.15)))) {
            p.inwardImpulse = Math.min(4.0, (p.inwardImpulse || 0) + Math.abs(ay)); ay = 0; if (Math.sign(p.vy || 0) === sy) { p.vy = 0; p.ry = 0; } p.freeSteps = 0;
          }
        }
      }

      const pvx = p.vx || 0, pvy = p.vy || 0;
      if (!ax && !ay && !pvx && !pvy) continue;
      const isEj = p.ejectaTicks > 0; if (isEj) p.ejectaTicks--;
      const drag = isEj ? 0.992 : (starModeActive ? UPC_CONFIG.starDrag : 0.94);
      let vx = (pvx + ax) * drag, vy = (pvy + ay) * drag;
      const cap = isEj ? MAX_SPEED * 1.8 : MAX_SPEED, spd2 = vx * vx + vy * vy;
      if (spd2 > cap * cap) { const sc = cap / Math.sqrt(spd2); vx *= sc; vy *= sc; }
      if (!ax && Math.abs(vx) < 0.015) vx = 0;
      if (!ay && Math.abs(vy) < 0.015) vy = 0;
      p.vx = vx; p.vy = vy;
      if (vx || vy) { movingNow++; p.rx = (p.rx || 0) + vx; p.ry = (p.ry || 0) + vy; advancePixelByVelocity(p); }
    }
    movingPixelsLastTick = movingNow; UPC_STATS.movingPixels = movingNow;
  }

  function drawFieldOverlay() {
    const c2d = getDrawCtx(), ps = Number(typeof pixelSize !== "undefined" ? pixelSize : 0);
    if (!visualizerActive || (!gravFieldActive && !magFieldActive) || !c2d || !ps || Number.isNaN(ps)) return;
    c2d.save(); c2d.lineWidth = Math.max(1, ps * 0.22);
    const stepPx = activeFieldBlock * ps;
    for (let by = 0; by < fieldMh - 1; by++) for (let bx = 0; bx < fieldMw - 1; bx++) {
      const idx = by * fieldMw + bx, cx = bx * stepPx, cy = by * stepPx;
      if (magFieldActive) { const bL = Math.hypot(macroBx[idx], macroBy[idx]); if (bL > 0.15) { const d = Math.min(stepPx * 0.45, Math.log1p(bL) * stepPx * 0.22); c2d.strokeStyle = "rgba(0,235,255,.55)"; c2d.beginPath(); c2d.moveTo(cx, cy); c2d.lineTo(cx + (macroBx[idx] / bL) * d, cy + (macroBy[idx] / bL) * d); c2d.stroke(); } }
      if (gravFieldActive) { const gL = Math.hypot(macroGx[idx], macroGy[idx]); if (gL > 0.4) { const d = Math.min(stepPx * 0.45, Math.log1p(gL) * stepPx * 0.16); c2d.strokeStyle = "rgba(255,196,61,.50)"; c2d.beginPath(); c2d.moveTo(cx, cy); c2d.lineTo(cx + (macroGx[idx] / gL) * d, cy + (macroGy[idx] / gL) * d); c2d.stroke(); } }
    }
    c2d.restore();
  }

  // ---------------------------------------------------------------------------
  // 5. NUCLEAR FISSION & IONIZING RADIATION ENGINE
  // ---------------------------------------------------------------------------

  const MOD_PROB = { water: 0.32, ice: 0.28, heavy_water: 0.26, heavy_ice: 0.24, graphite: 0.20, paraffin: 0.30 };
  const REFLECTORS = new Set(["beryllium", "molten_beryllium", "tungsten", "steel"]);
  const POISONS = new Set(["boron", "molten_boron", "cadmium", "molten_cadmium", "hafnium", "molten_hafnium", "xenon_135"]);
  const HIGH_Z = new Set(["lead", "molten_lead", "tungsten", "osmium", "uranium_238", "concrete"]);
  const BETA_SHD = new Set(["aluminum", "iron", "steel", "copper", "glass", "lead", "tungsten", "osmium", "concrete", "titanium"]);
  const FISSILE = {
    uranium_235: { th: 0.28, fa: 0.025, n: [2, 3], h: 1500, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    molten_uranium_235: { th: 0.25, fa: 0.022, n: [2, 3], h: 1500, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    plutonium_239: { th: 0.32, fa: 0.085, n: [2, 3], h: 1750, d: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    molten_plutonium_239: { th: 0.30, fa: 0.075, n: [2, 3], h: 1750, d: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    uranium_233: { th: 0.30, fa: 0.045, n: [2, 3], h: 1450, d: ["barium_141", "krypton_92", "strontium_90"] },
    molten_uranium_233: { th: 0.27, fa: 0.040, n: [2, 3], h: 1450, d: ["barium_141", "krypton_92", "strontium_90"] },
    uranium: { th: 0.12, fa: 0.010, n: [2, 2], h: 1050, d: ["barium_141", "krypton_92", "xenon_135"] },
    plutonium: { th: 0.32, fa: 0.085, n: [2, 3], h: 1750, d: ["barium_141", "xenon_135", "strontium_90"] },
    enriched_uranium: { th: 0.27, fa: 0.025, n: [2, 3], h: 1500, d: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] }
  };

  let lastPhysTick = -1, nThisTick = 0, prevN = 0, spThisTick = 0, ionThisTick = 0, lastExpTick = -100, logNErr = false;
  function syncPhys() {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t !== lastPhysTick) { prevN = nThisTick; UPC_STATS.activeNeutrons = nThisTick; nThisTick = 0; spThisTick = 0; ionThisTick = 0; lastPhysTick = t; }
  }

  function spawnParticle(cx, cy, elem, cnt = 1) {
    syncPhys(); if (!elements[elem] || ionThisTick >= 180) return;
    const dirs = DIRS.slice().sort(() => Math.random() - 0.5);
    for (let i = 0, sp = 0; i < 8 && sp < cnt && ionThisTick < 180; i++) {
      const np = safeCreate(elem, cx + dirs[i][0], cy + dirs[i][1]);
      if (np) { np.vx = dirs[i][0]; np.vy = dirs[i][1]; np.life = elem === "alpha_particle" ? 22 : elem === "beta_particle" ? 65 : 100; sp++; ionThisTick++; }
    }
  }

  function spawnNeutronsAround(cx, cy, cnt, type = "fast_neutron") {
    syncPhys(); if (!elements[type] || prevN + spThisTick >= MAX_NEUTRONS || spThisTick >= 28) return;
    const dirs = DIRS.slice().sort(() => Math.random() - 0.5);
    for (let i = 0, sp = 0; i < 8 && sp < cnt && prevN + spThisTick < MAX_NEUTRONS && spThisTick < 28; i++) {
      for (let d = 1; d <= 2; d++) {
        const np = safeCreate(type, cx + dirs[i][0] * d, cy + dirs[i][1] * d);
        if (np) { np.vx = dirs[i][0]; np.vy = dirs[i][1]; np.life = 135; sp++; spThisTick++; break; }
      }
    }
  }

  function triggerFission(tp, spec, np) {
    syncPhys(); if (!tp || tp.del) return;
    const tx = tp.x, ty = tp.y, h = Math.round(spec.h * UPC_CONFIG.fissionHeatScale);
    safeChange(tp, spec.d[Math.floor(Math.random() * spec.d.length)]); tp.temp += h;
    tp.radEnergy = Math.min(380, (tp.radEnergy || 0) + 45);
    let near = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      if (!inSafeBounds(tx + dx, ty + dy)) continue;
      const q = pixelMap[tx + dx][ty + dy];
      if (q && !q.del) { q.temp += Math.round(h * 0.16); q.radEnergy = Math.min(380, (q.radEnergy || 0) + 12); if (FISSILE[q.element]) near++; }
    }
    if (np && !np.del && inSafeBounds(np.x, np.y) && pixelMap[np.x][np.y] === np) deletePixel(np.x, np.y);
    spawnNeutronsAround(tx, ty, spec.n[0] + (Math.random() < 0.4 ? spec.n[1] - spec.n[0] : 0), "fast_neutron");
    if (Math.random() < 0.25) spawnParticle(tx, ty, "gamma_ray", 1);
    if (tp.temp > 7500 && near >= 12 && lastPhysTick - lastExpTick >= 14) { lastExpTick = lastPhysTick; explodeAt(tx, ty, 9, "plasma,fire,radiation,fallout"); }
  }

  function ionTick(p, kind) {
    if (!p || p.del) return;
    syncPhys(); if (++ionThisTick > 250) { deletePixel(p.x, p.y); return; }
    if (!p.vx && !p.vy) { const d = randomDir(); p.vx = d[0]; p.vy = d[1]; }
    if (p.life === undefined) p.life = kind === "alpha" ? 22 : kind === "beta" ? 65 : 100;
    if (--p.life <= 0) { if (kind === "alpha" && Math.random() < 0.35 && elements.helium) safeChange(p, "helium"); else deletePixel(p.x, p.y); return; }
    for (let s = 0, st = kind === "gamma" ? 2 : 1; s < st && !p.del; s++) {
      const nx = p.x + p.vx, ny = p.y + p.vy;
      if (!inSafeBounds(nx, ny)) { deletePixel(p.x, p.y); return; }
      if (isEmpty(nx, ny)) { movePixel(p, nx, ny); continue; }
      const t = pixelMap[nx][ny]; if (!t || t === p || t.del) continue;
      const te = t.element;
      if (kind === "alpha") {
        if (te === "beryllium" || te === "molten_beryllium") { spawnNeutronsAround(t.x, t.y, 1, "fast_neutron"); t.temp += 60; deletePixel(p.x, p.y); return; }
        if (elements[te]?.state === "gas") { safeSwap(p, t); t.temp += 4; } else { t.temp += 35; if (Math.random() < 0.25 && elements.helium) safeChange(p, "helium"); else deletePixel(p.x, p.y); return; }
      } else if (kind === "beta") {
        if (BETA_SHD.has(te)) { t.temp += 18; deletePixel(p.x, p.y); return; }
        t.temp += 5; safeSwap(p, t);
      } else {
        if (HIGH_Z.has(te) && Math.random() < 0.55) { t.temp += 28; deletePixel(p.x, p.y); return; }
        t.temp += 8; safeSwap(p, t);
      }
    }
  }

  function neutronTick(p, isFast) {
    try {
      if (!p || p.del) return;
      syncPhys(); if (++nThisTick > MAX_NEUTRONS * 1.25) { deletePixel(p.x, p.y); return; }
      if (!p.vx && !p.vy) { const d = randomDir(); p.vx = d[0]; p.vy = d[1]; }
      if (p.life === undefined) p.life = 135;
      if (--p.life <= 0) { safeChangeAny(p, ["proton", "hydrogen"]); return; }
      if (!isFast && Math.random() > 0.55) return;
      for (let s = 0, st = isFast ? (Math.random() < 0.35 ? 2 : 1) : 1; s < st && !p.del; s++) {
        const nx = p.x + p.vx, ny = p.y + p.vy;
        if (!inSafeBounds(nx, ny)) { deletePixel(p.x, p.y); return; }
        if (isEmpty(nx, ny)) { movePixel(p, nx, ny); continue; }
        const t = pixelMap[nx][ny]; if (!t || t === p || t.del) continue;
        const te = t.element;
        if (FISSILE[te]) {
          const sp = FISSILE[te];
          let pr = (isFast ? sp.fa : sp.th) * UPC_CONFIG.fissionRate;
          if (!isFast && t.temp > 1200) pr *= Math.max(0.6, 1 - (t.temp - 1200) / 10000);
          if (Math.random() < pr) { triggerFission(t, sp, p); return; }
          if (Math.random() < 0.55) safeSwap(p, t); else { p.vx = -p.vx; p.vy = -p.vy; }
          return;
        }
        if (isFast && t.temp > 75000 && SUPER_R_TARGETS.has(te) && Math.random() < 0.2) { safeChange(t, R_PRODUCTS[Math.floor(Math.random() * R_PRODUCTS.length)]); deletePixel(p.x, p.y); return; }
        if ((te === "uranium_238" || te === "molten_uranium_238") && Math.random() < ((isFast ? 0.05 : 0.16) + (t.temp > 800 ? 0.04 : 0)) * UPC_CONFIG.fissionRate) { safeChange(t, "neptunium_239"); t.temp += 110; deletePixel(p.x, p.y); return; }
        if ((te === "thorium_232" || te === "molten_thorium_232" || te === "thorium") && Math.random() < (isFast ? 0.04 : 0.18) * UPC_CONFIG.fissionRate) { safeChange(t, "protactinium_233"); t.temp += 100; deletePixel(p.x, p.y); return; }
        if ((te === "lithium_6" || te === "molten_lithium_6") && Math.random() < 0.3) { safeChange(t, "tritium"); t.temp += 650; safeChange(p, "helium"); return; }
        if ((te === "cobalt" || te === "molten_cobalt") && Math.random() < 0.14) { safeChange(t, "cobalt_60"); t.temp += 90; deletePixel(p.x, p.y); return; }
        if (te === "nitrogen" && !isFast && Math.random() < 0.06) { safeChange(t, "carbon_14"); safeChangeAny(p, ["proton", "hydrogen"]); return; }
        if (POISONS.has(te) && !isFast && Math.random() < (te === "xenon_135" ? 0.9 : 0.72)) {
          t.temp += 60; if (te === "boron" && Math.random() < 0.12) safeChange(t, "lithium_7"); else if (te === "xenon_135") safeChange(t, "xenon_136");
          deletePixel(p.x, p.y); return;
        }
        if (MOD_PROB[te] !== undefined) {
          t.temp += isFast ? 24 : 3;
          if (isFast) {
            if (te === "water" && Math.random() < 0.025) { safeChange(t, "heavy_water"); deletePixel(p.x, p.y); return; }
            if (Math.random() < MOD_PROB[te]) { safeChange(p, "thermal_neutron"); const d = randomDir(); p.vx = d[0]; p.vy = d[1]; return; }
          }
          safeSwap(p, t); return;
        }
        if (REFLECTORS.has(te)) {
          p.vx = Math.max(-1, Math.min(1, -p.vx + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0)));
          p.vy = Math.max(-1, Math.min(1, -p.vy + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0)));
          if (!p.vx && !p.vy) { const d = randomDir(); p.vx = d[0]; p.vy = d[1]; }
          if (isFast && !p.beM && (te === "beryllium" || te === "molten_beryllium") && Math.random() < 0.05) { p.beM = true; spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); }
          return;
        }
        if (HIGH_Z.has(te)) { t.temp += 12; if (Math.random() < 0.42) { deletePixel(p.x, p.y); return; } p.vx = -p.vx; p.vy = -p.vy; return; }
        const ts = elements[te]?.state;
        if (ts === "gas" || te === "fire" || te === "plasma" || RAD_AGENTS.has(te)) safeSwap(p, t); else { const d = randomDir(); p.vx = d[0]; p.vy = d[1]; return; }
      }
    } catch (err) { if (!logNErr) { logNErr = true; console.error("[UPC] neutronTick:", err); } }
  }

  // ---------------------------------------------------------------------------
  // 6. TOOLS, ASTROPHYSICS, MAGNETS, NUCLEAR & CHEMICAL ELEMENTS
  // ---------------------------------------------------------------------------

  reg("orbit_launch", {
    color: ["#ffcf40", "#ffe082"], category: "tools", desc: "Gives brushed matter circular orbital velocity perpendicular to local gravity.",
    tool: (p) => {
      if (!p || p.del || isImmobile(p.element) || VEL_EXEMPT.has(p.element)) return;
      if (!gravFieldActive) rebuildFields(); if (!gravFieldActive) return;
      const gx = sampleField(macroGx, p.x, p.y), gy = sampleField(macroGy, p.x, p.y), gM = Math.hypot(gx, gy);
      if (gM < 0.01) return;
      const sM = (starModeActive && UPC_CONFIG.gravityMethod !== "com") ? getVoxelMass(p) : 0;
      const vC = Math.min(MAX_SPEED * 0.92, Math.sqrt(4 * Math.max(0, sampleField(macroPhi, p.x, p.y) - sM * SELF_PHI_UNIT) * GRAV_ACCEL));
      p.vx = (-gy / gM) * vC; p.vy = (gx / gM) * vC; movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }
  });
  reg("kinetic_launch", { color: ["#ff6e40", "#ff9e80"], category: "tools", desc: "Launches matter right & upward.", tool: (p) => { if (p && !p.del && !isImmobile(p.element) && !VEL_EXEMPT.has(p.element)) { p.vx = MAX_SPEED * 0.88; p.vy = -0.35; movingPixelsLastTick = Math.max(movingPixelsLastTick, 1); } } });
  reg("vel_stop", { color: ["#78909c", "#b0bec5"], category: "tools", desc: "Cancels velocity.", tool: (p) => { if (p && !p.del) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; } } });
  reg("compress_tool", {
    color: ["#ab47bc", "#ce93d8"], category: "tools", desc: "Compresses compressible voxels (respecting liquid incompressibility & degeneracy wall) or presses graphite -> diamond / ice -> water.",
    tool: (p) => {
      if (!p || p.del) return;
      const st = elements[p.element]?.state || "solid", effComp = getCompressibility(p);
      if (p.element === "graphite" && p.temp >= 1200 && elements.diamond) { safeChange(p, "diamond"); return; }
      if (p.element === "ice" && elements.water) { safeChange(p, "water"); return; }
      if (st === "liquid" || effComp <= 0.0002) return;
      if (Math.random() < Math.min(1, effComp * 1.6)) {
        const nb = findAdj(p, p.element);
        if (nb && mergeVoxelInto(p, nb, st)) {
          if (gravFieldActive) evaluateWallState(p, sampleField(macroPhi, p.x, p.y), p.pGrav || 0, computeEOSPressure(p));
        } else if (st === "gas") p.temp += 1100;
      }
      p.pressure = Math.round(computeEOSPressure(p));
      updatePackColor(p);
    }
  });
  reg("bond_tool", { color: ["#69f0ae", "#b9f6ca"], category: "tools", desc: "Bonds adjacent pixels.", tool: (p) => { if (!p || p.del || getBondCount(p) >= 3) return; for (const d of DIRS) { const nx = p.x + d[0], ny = p.y + d[1]; if (inSafeBounds(nx, ny) && pixelMap[nx][ny] && !pixelMap[nx][ny].del && !hasBond(p, pixelMap[nx][ny]) && createBond(p, pixelMap[nx][ny], "catalyst", 2800)) return; } } });
  reg("cleave_tool", { color: ["#ff5252", "#ff8a80"], category: "tools", desc: "Cleaves bonds.", tool: (p) => { if (p && !p.del) breakAllBonds(p); } });
  reg("magnetize_tool", { color: ["#e53935", "#1e88e5"], category: "tools", desc: "Magnetizes metals or flips N <-> S.", tool: (p) => { if (!p || p.del) return; const m = { iron: "magnet_north", steel: "magnet_north", iron_filings: "magnet_bead_n", neodymium: "neodymium_north", magnet_north: "magnet_south", magnet_south: "magnet_north", neodymium_north: "neodymium_south", neodymium_south: "neodymium_north", magnet_bead_n: "magnet_bead_s", magnet_bead_s: "magnet_bead_n" }; if (m[p.element]) safeChange(p, m[p.element]); } });
  reg("neutron_pulse", { color: ["#ff6d00", "#ffd180"], category: "tools", desc: "Emits fast neutrons.", tool: (p) => { if (p && !p.del && Math.random() < 0.25) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); } });

  let lastInsp = 0;
  reg("inspect_tool", {
    color: ["#26c6da", "#80deea"], category: "tools", desc: "Displays state, temp, mass, pack/wall, effComp, P vs G, radE, Phi, B, and bonds.",
    tool: (p) => {
      if (!p || p.del) return; const now = Date.now(); if (now - lastInsp < 180) return; lastInsp = now;
      const phi = gravFieldActive ? Math.round(sampleField(macroPhi, p.x, p.y)) : 0;
      const b = magFieldActive ? sampleField(macroBmag, p.x, p.y).toFixed(1) : "0";
      const m = getVoxelMass(p).toFixed(1), ec = getCompressibility(p).toFixed(3), wall = getWallPack(p.element);
      const pb = getBonds(p), bl = pb?.length ? pb.map(x => `${x.target.element}(${x.type})`).join(", ") : "none";
      const extra = p.element === "black_hole_core" ? `bhMass=${m}M` : `pack=${(p.pack || 1).toFixed(1)}x/${wall}x | mass=${m}M | effC=${ec}`;
      notifyUser(`${p.element}[${elements[p.element]?.state || "?"}] | ${Math.round(p.temp)}C | ${extra} | P=${Math.round(computeEOSPressure(p))} vs G=${p.pGrav || 0} | radE=${Math.round(p.radEnergy || 0)} | Phi=${phi} | B=${b} | bonds:${bl}`, true);
    }
  });

  reg("star_gravity", { color: ["#1a0b2e", "#31135e", "#4d1f91"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 99999, hardness: 1, desc: "Enables Zero-G multi-body CIC self-gravity." });
  reg("gravity_well", { color: ["#120024", "#2a0052", "#5900a6"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 99999, hardness: 1, desc: "Localized gravity anchor." });
  reg("field_visualizer", { color: ["#00e5ff", "#ffd740"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 1000, desc: "Draws Magnetic (cyan) & Gravity (gold) vectors." });
  reg("neutronium", { color: ["#d9f7ff", "#ffffff", "#9ce5ff"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 999999, hardness: 1, conduct: 1, desc: "Hot degenerate neutron-star core. Accretes mass until crossing TOV -> Black Hole.", tick: (p) => { if (Math.random() < 0.002) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } });
  reg("black_hole_core", {
    color: ["#050008", "#0d0014", "#1a0029"], behavior: behaviors.WALL, category: "astrophysics", state: "solid", density: 9999999, hardness: 1, desc: "Event-horizon singularity. Stores devoured mass (bhMass) and displays it live on canvas.",
    tick: (p) => {
      if (!p.bhMass) p.bhMass = UPC_CONFIG.minBhMass;
      for (const d of DIRS) {
        const nx = p.x + d[0], ny = p.y + d[1];
        if (!inSafeBounds(nx, ny)) continue;
        const v = pixelMap[nx][ny];
        if (!v || v.del || IMMOBILE_SET.has(v.element)) continue;
        p.bhMass = +(p.bhMass + getVoxelMass(v)).toFixed(1);
        breakAllBonds(v); deletePixel(nx, ny);
        if (Math.random() < 0.18) spawnParticle(p.x, p.y, "gamma_ray", 1);
      }
      doDefaults(p);
    }
  });
  reg("bond_catalyst", {
    color: ["#6bff7a", "#9cff9e", "#3de050"], behavior: behaviors.POWDER, category: "chemistry", state: "solid", density: 10, desc: "Links two adjacent elements with a chemical bond.",
    tick: (p) => {
      const nb = [];
      for (const d of DIRS) { const nx = p.x + d[0], ny = p.y + d[1]; if (inSafeBounds(nx, ny) && pixelMap[nx][ny] && !pixelMap[nx][ny].del && pixelMap[nx][ny].element !== "bond_catalyst" && pixelMap[nx][ny].element !== "bond_breaker") nb.push(pixelMap[nx][ny]); }
      for (let a = 0; a < nb.length; a++) for (let b = a + 1; b < nb.length; b++) if (Math.max(Math.abs(nb[a].x - nb[b].x), Math.abs(nb[a].y - nb[b].y)) <= 2 && createBond(nb[a], nb[b], "catalyst", 2600)) { deletePixel(p.x, p.y); return; }
      doDefaults(p);
    }
  });
  reg("bond_breaker", { color: ["#ff477e", "#ff7096", "#e0245e"], behavior: behaviors.GAS, category: "chemistry", state: "gas", density: 0.5, desc: "Cleaves bonds on contact.", tick: (p) => { if (p.life === undefined) p.life = 25; if (--p.life <= 0) { deletePixel(p.x, p.y); return; } doDefaults(p); } });

  reg("magnet_north", { color: ["#d92626", "#e83838", "#bf1d1d"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.5, hardness: 0.8, tempHigh: 770, stateHigh: "iron", desc: "North pole (Curie: 770 C)." });
  reg("magnet_south", { color: ["#1e5ad9", "#2e6df0", "#1749b5"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.5, hardness: 0.8, tempHigh: 770, stateHigh: "iron", desc: "South pole (Curie: 770 C)." });
  reg("neodymium_north", { color: ["#ff1744", "#ff4569", "#d5002f"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.45, hardness: 0.75, tempHigh: 310, stateHigh: "neodymium", desc: "Neodymium North (Curie: 310 C)." });
  reg("neodymium_south", { color: ["#0044ff", "#2962ff", "#0032bd"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 7500, conduct: 0.45, hardness: 0.75, tempHigh: 310, stateHigh: "neodymium", desc: "Neodymium South (Curie: 310 C)." });
  reg("electromagnet_north", { color: ["#b85d38", "#cc6b43", "#9e4d2d"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 8400, conduct: 1, hardness: 0.8, desc: "Switchable North Electromagnet." });
  reg("electromagnet_south", { color: ["#486b9e", "#587eb5", "#3b5985"], behavior: behaviors.WALL, category: "magnets", state: "solid", density: 8400, conduct: 1, hardness: 0.8, desc: "Switchable South Electromagnet." });
  reg("magnet_bead_n", { color: ["#ff5252", "#ff7575"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7400, hardness: 0.75, tempHigh: 770, stateHigh: "iron_filings", desc: "Movable North bead." });
  reg("magnet_bead_s", { color: ["#448aff", "#69a1ff"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7400, hardness: 0.75, tempHigh: 770, stateHigh: "iron_filings", desc: "Movable South bead." });
  reg("iron_filings", { color: ["#525559", "#64686e", "#43464a"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 7870, conduct: 0.7, hardness: 0.72, tempHigh: 1538, stateHigh: "molten_iron", desc: "Ferromagnetic iron powder." });
  reg("superconductor", { color: ["#242933", "#303745", "#1c2029"], behavior: behaviors.POWDER, category: "magnets", state: "solid", density: 6300, conduct: 1, hardness: 0.7, desc: "Meissner levitation below -180 C." });

  reg("fast_neutron", { color: ["#ff4444", "#ff7744", "#ffaa44"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, temp: 20, desc: "Fast ~2 MeV neutron.", tick: (p) => neutronTick(p, true) });
  reg("thermal_neutron", { color: ["#44ccff", "#66eeff", "#99f5ff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, temp: 20, desc: "Thermal neutron.", tick: (p) => neutronTick(p, false) });
  reg("alpha_particle", { color: ["#ffea00", "#ffff72"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Alpha particle.", tick: (p) => ionTick(p, "alpha") });
  reg("beta_particle", { color: ["#00e5ff", "#84ffff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Beta electron.", tick: (p) => ionTick(p, "beta") });
  reg("gamma_ray", { color: ["#ea80fc", "#ffffff"], behavior: behaviors.WALL, category: "nuclear", state: "gas", density: 0.01, desc: "Gamma photon.", tick: (p) => ionTick(p, "gamma") });
  reg("heavy_water", { color: ["#1e5ec4", "#246ad6", "#1a52ab"], behavior: behaviors.LIQUID, category: "nuclear", state: "liquid", density: 1107, tempHigh: 101.4, stateHigh: "heavy_steam", tempLow: 3.8, stateLow: "heavy_ice", conduct: 0.02, desc: "D2O moderator." });
  reg("heavy_ice", { color: ["#a8d0f5", "#b8daf8"], behavior: behaviors.WALL, category: "states", state: "solid", hidden: true, density: 1017, temp: 0, tempHigh: 3.8, stateHigh: "heavy_water" });
  reg("heavy_steam", { color: ["#c7dbf0", "#d7e6f5"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 0.66, temp: 110, tempLow: 101.4, stateLow: "heavy_water", tick: (p) => { if (p.temp >= 3200 && Math.random() < 0.07) { safeChange(p, Math.random() < 0.66 ? "deuterium" : "oxygen"); return; } doDefaults(p); } });
  reg("carbon_vapor", {
    color: ["#54545c", "#666670", "#45454d"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 0.52, temp: 3700, tempLow: 3642, stateLow: "graphite", desc: "Carbon-12 gas (>3,642 C). Fuses with He (76k C) or C (98k C).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0) {
        if (p.temp >= 76000 && Math.random() < 0.011 * fr) { const he = findAdj(p, "helium"); if (he) { fusePair(p, he, "oxygen", "gamma_ray", 2400, 75); return; } }
        if (p.temp >= 98000 && Math.random() < 0.020 * fr) { const o = findAdj(p, "carbon_vapor"); if (o) { fusePair(p, o, Math.random() < 0.55 ? "neon" : "magnesium_gas", "gamma_ray", 2600, 80); return; } }
      }
      doDefaults(p);
    },
    reactions: { oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.12 } }
  });
  reg("graphite", {
    _override: true, color: ["#2b2b2e", "#36363a", "#232326"], behavior: behaviors.WALL, category: "nuclear", state: "solid", density: 2260, conduct: 0.85, hardness: 0.65, tempHigh: 3642, stateHigh: "carbon_vapor", desc: "Carbon moderator; smelts sand -> Si & rust -> Fe; presses to diamond.",
    reactions: { oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.08 }, sand: { elem1: "carbon_dioxide", elem2: "molten_silicon", tempMin: 1900, tempMax: 3500, chance: 0.12 }, rust: { elem1: "carbon_dioxide", elem2: "molten_iron", tempMin: 1100, tempMax: 3200, chance: 0.14 } }
  });

  const SI_STATES = new Set(["silicon", "molten_silicon", "silicon_gas"]);
  defGas({
    id: "deuterium", color: ["#6ea8ff", "#88bbff"], liquidColor: ["#3c7de0", "#4f8ef0"], solidColor: ["#a6cbff", "#c2dcff"], category: "isotopes", boilTemp: -249.5, meltTemp: -254.4, density: 0.18, desc: "H-2 fusion fuel (D+T 10k, D+H 14k, D+D 25k, D+He3 38k).",
    tick: (p) => {
      const fr = getFusionFactor(p);
      if (fr > 0) {
        if (p.temp >= 10000 && Math.random() < 0.05 * fr) { const t = findAdj(p, "tritium"); if (t) { fusePair(p, t, "helium", "fast_neutron", 4500, 85); return; } }
        if (p.temp >= 14000 && Math.random() < 0.012 * fr) { const h = findAdj(p, "hydrogen"); if (h) { fusePair(p, h, "helium_3", "gamma_ray", 1300, 65); return; } }
        if (p.temp >= 25000 && Math.random() < 0.015 * fr) { const o = findAdj(p, "deuterium"); if (o) { fusePair(p, o, Math.random() < 0.5 ? "tritium" : "helium_3", Math.random() < 0.5 ? "proton" : "fast_neutron", 2200, 70); return; } }
        if (p.temp >= 38000 && Math.random() < 0.025 * fr) { const h3 = findAdj(p, "helium_3"); if (h3) { fusePair(p, h3, "helium", "proton", 4800, 85); return; } }
      }
      doDefaults(p);
    },
    reactions: { oxygen: { elem1: "heavy_steam", elem2: "fire", tempMin: 560, tempMax: 3000, chance: 0.35 } }
  });
  defGas({ id: "tritium", color: ["#5cffb0", "#82ffc4"], liquidColor: ["#28d483", "#3ee093"], solidColor: ["#9effd0", "#c4ffe2"], category: "isotopes", boilTemp: -248.1, meltTemp: -252.5, density: 0.27, desc: "H-3 -> He-3.", tick: (p) => { if (Math.random() < 0.00005) { safeChange(p, "helium_3"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 5; return; } doDefaults(p); } });
  defGas({ id: "helium_3", color: ["#ffe0b3", "#ffd18c"], liquidColor: ["#f0b86e", "#e6a855"], solidColor: ["#fff0d9", "#ffe6bf"], category: "isotopes", boilTemp: -269.9, meltTemp: -272.2, density: 0.13, desc: "He-3 p-p chain & aneutronic fuel (22k C).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 22000 && Math.random() < 0.014 * fr) { const o = findAdj(p, "helium_3"); if (o) { fusePair(p, o, "helium", "proton", 1800, 75); return; } } doDefaults(p); } });
  defGas({ id: "neon", color: ["#ff9678", "#ffab91"], liquidColor: ["#ff7043", "#ff8a65"], solidColor: ["#ffccbc", "#ffd8cc"], category: "gases", boilTemp: -246.1, meltTemp: -248.6, density: 0.90, conduct: 0.4, desc: "Fuses with He (112k C -> Mg).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 112000 && Math.random() < 0.028 * fr) { const he = findAdj(p, "helium"); if (he) { fusePair(p, he, "magnesium_gas", "gamma_ray", 2400, 75); return; } } doDefaults(p); } });
  defGas({ id: "argon", color: ["#c7b8ff", "#d6ccff"], liquidColor: ["#9b87f5", "#ac99ff"], solidColor: ["#e6e0ff", "#f0ecff"], category: "gases", boilTemp: -185.8, meltTemp: -189.3, density: 1.78, desc: "Inert shielding gas." });
  defGas({ id: "radon", color: ["#b8e0c8", "#ccebd8"], liquidColor: ["#8ac2a0", "#9cd4b2"], solidColor: ["#ffaa55", "#ff8844"], category: "isotopes", boilTemp: -61.7, meltTemp: -71.0, density: 9.73, desc: "Radon -> Po-210.", tick: (p) => { if (Math.random() < 0.00018) { safeChange(p, "polonium_210"); spawnParticle(p.x, p.y, "alpha_particle", 1); p.temp += 15; return; } doDefaults(p); } });
  defGas({ id: "xenon_135", color: ["#9a78e3", "#b091f2"], liquidColor: ["#6c47bd", "#7d55d1"], solidColor: ["#c6b3f5", "#d8c9fa"], category: "isotopes", boilTemp: -108.1, meltTemp: -111.8, density: 5.89, desc: "Reactor poison -> Cs-135.", tick: (p) => { if (Math.random() < 0.0004) { safeChange(p, "cesium_135"); spawnParticle(p.x, p.y, "beta_particle", 1); return; } doDefaults(p); } });
  defGas({ id: "xenon_136", color: ["#7c6fa8", "#9183bd"], liquidColor: ["#5a4d82", "#695a94"], solidColor: ["#b5abdb", "#c8c0e6"], category: "isotopes", boilTemp: -108.1, meltTemp: -111.8, density: 5.93, desc: "Stable Xenon-136." });
  defGas({ id: "krypton_92", color: ["#b8d4e8", "#cfe5f5"], liquidColor: ["#80a8c7", "#92bad9"], solidColor: ["#dcebf7", "#ebf4fc"], category: "isotopes", boilTemp: -153.4, meltTemp: -157.4, density: 3.75, desc: "Delayed-neutron fission gas -> Sr-90.", tick: (p) => { p.temp += 0.08; if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.0006) spawnNeutronsAround(p.x, p.y, 1, "thermal_neutron"); if (Math.random() < 0.0012) { safeChange(p, "strontium_90"); return; } doDefaults(p); } });

  [
    { id: "carbon_14", color: ["#303835", "#3d4743"], moltenColor: ["#7a8f87", "#8ea69d"], gasColor: ["#5c6b65", "#6d7d77"], category: "isotopes", meltTemp: 3550, boilTemp: 4027, density: 2260, conduct: 0.7, behavior: behaviors.POWDER, desc: "C-14 -> N-14.", tick: (p) => { if (Math.random() < 0.00004) { safeChange(p, "nitrogen"); spawnParticle(p.x, p.y, "beta_particle", 1); return; } doDefaults(p); } },
    { id: "magnesium", color: ["#d4d9de", "#e2e6eb", "#c5cbd1"], moltenColor: ["#f0e8d5", "#fff8e8"], gasColor: ["#e8ecf0", "#f5f7fa"], category: "metals", meltTemp: 650, boilTemp: 1091, density: 1738, conduct: 0.78, hardness: 0.5, tickAllStates: true, desc: "Fuses with He (118k C -> Si).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 118000 && Math.random() < 0.030 * fr) { const he = findAdj(p, "helium"); if (he) { fusePair(p, he, "silicon_gas", "gamma_ray", 2400, 75); return; } } doDefaults(p); }, reactions: { oxygen: { elem1: "ash", elem2: "fire", tempMin: 470, tempMax: 3200, chance: 0.25, func: q => { q.temp += 1400; } }, steam: { elem1: "ash", elem2: "hydrogen", tempMin: 300, chance: 0.2, func: q => { q.temp += 700; } } } },
    { id: "silicon", color: ["#4b525c", "#58606b", "#3f464f"], moltenColor: ["#e8a86b", "#f2b97e"], gasColor: ["#8a96a6", "#9ca8b8"], category: "solids", meltTemp: 1414, boilTemp: 3265, density: 2329, conduct: 0.35, hardness: 0.82, tickAllStates: true, desc: "Si-28; rapid final burn past 155k C -> Ni-56 -> Fe.", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 155000 && Math.random() < 0.055 * fr) { const pt = findAdj(p, "helium") || findAdj(p, SI_STATES); if (pt) { fusePair(p, pt, "nickel_56_gas", "gamma_ray", 1800, 50); return; } } doDefaults(p); }, reactions: { oxygen: { elem1: "sand", elem2: "fire", tempMin: 900, tempMax: 2500, chance: 0.08 } } },
    { id: "nickel_56", color: ["#9cb5a8", "#adc7b9"], moltenColor: ["#ffbe76", "#ffd39b"], gasColor: ["#c7e3d4", "#daf2e5"], category: "isotopes", meltTemp: 1455, boilTemp: 2913, density: 8908, conduct: 0.7, tickAllStates: true, desc: "Ni-56 -> Co-56 -> Fe-56.", tick: (p) => { p.temp += 0.2; if (Math.random() < (p.temp > 120000 ? 0.012 : 0.0025)) { safeChange(p, p.element === "nickel_56_gas" ? "cobalt_56_gas" : p.element === "molten_nickel_56" ? "molten_cobalt_56" : "cobalt_56"); p.temp += 120; return; } doDefaults(p); } },
    { id: "cobalt_56", color: ["#7295c4", "#86a8d6"], moltenColor: ["#ffa366", "#ffb885"], gasColor: ["#a4bfe3", "#b8cff0"], category: "isotopes", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.7, tickAllStates: true, desc: "Co-56 -> Iron-56.", tick: (p) => { p.temp += 0.14; if (Math.random() < (p.temp > 120000 ? 0.010 : 0.0020)) { if (p.temp >= 2862) safeChangeAny(p, ["iron_gas", "molten_iron", "iron"]); else if (p.temp >= 1538) safeChangeAny(p, ["molten_iron", "iron"]); else safeChange(p, "iron"); p.temp += 90; return; } doDefaults(p); } },
    { id: "uranium_235", color: ["#4b7843", "#578c4e", "#3f6938"], moltenColor: ["#9be05a", "#b7f06e"], gasColor: ["#88b878", "#a2cc95"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 18950, conduct: 0.45, desc: "Fissile U-235.", tick: (p) => { if (Math.random() < 0.00005) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "uranium_238", color: ["#3b4d3b", "#455945", "#324232"], moltenColor: ["#7a9c59", "#8eb06a"], gasColor: ["#6b7d6b", "#7c8f7c"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 19100, conduct: 0.45, desc: "Fertile U-238 -> Pu-239." },
    { id: "neptunium_239", color: ["#5e6e7d", "#6e8091"], moltenColor: ["#b58d52", "#cfa363"], gasColor: ["#8e9eab", "#a3b3c2"], category: "isotopes", meltTemp: 644, boilTemp: 3902, density: 20450, conduct: 0.35, desc: "Np-239 -> Pu-239.", tick: (p) => { p.temp += 0.05; if (Math.random() < 0.0008) { safeChange(p, "plutonium_239"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 45; return; } doDefaults(p); } },
    { id: "plutonium_239", color: ["#6b756b", "#7d8a7d", "#5c665c"], moltenColor: ["#e68a45", "#f5a056"], gasColor: ["#9ca89c", "#b0bdb0"], category: "nuclear", meltTemp: 640, boilTemp: 3228, density: 19816, conduct: 0.25, desc: "Fissile Pu-239.", tick: (p) => { p.temp += 0.03; if (Math.random() < 0.00014) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "thorium_232", color: ["#63605c", "#75726d", "#575450"], moltenColor: ["#d98a4e", "#eb9e60"], gasColor: ["#8f8b85", "#a39f98"], category: "nuclear", meltTemp: 1750, boilTemp: 4788, density: 11724, conduct: 0.5, desc: "Fertile Th-232 -> U-233." },
    { id: "protactinium_233", color: ["#7a7380", "#8c8494"], moltenColor: ["#c78b63", "#db9e74"], gasColor: ["#a199a8", "#b3abc0"], category: "isotopes", meltTemp: 1568, boilTemp: 4027, density: 15370, conduct: 0.4, desc: "Pa-233 -> U-233.", tick: (p) => { p.temp += 0.04; if (Math.random() < 0.0006) { safeChange(p, "uranium_233"); spawnParticle(p.x, p.y, "beta_particle", 1); p.temp += 35; return; } doDefaults(p); } },
    { id: "uranium_233", color: ["#4d8066", "#5a9476", "#427058"], moltenColor: ["#8be0a4", "#a3f0ba"], gasColor: ["#84b89c", "#9accb1"], category: "nuclear", meltTemp: 1132, boilTemp: 4131, density: 18900, conduct: 0.45, desc: "Fissile U-233." },
    { id: "californium_252", color: ["#a8b099", "#bcc4ab"], moltenColor: ["#ffad66", "#ffc285"], gasColor: ["#d4dbc5", "#e4ebd5"], category: "nuclear", meltTemp: 900, boilTemp: 1470, density: 15100, conduct: 0.4, desc: "Spontaneous neutron source.", tick: (p) => { p.temp += 0.2; if (Math.random() < 0.008) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); } },
    { id: "americium_241", color: ["#c2c7cc", "#d3d8de"], moltenColor: ["#f0b07a", "#ffc48f"], gasColor: ["#dee3e8", "#eef2f7"], category: "isotopes", meltTemp: 1176, boilTemp: 2607, density: 13670, conduct: 0.45, desc: "Alpha emitter.", tick: (p) => { p.temp += 0.08; if (Math.random() < 0.006) spawnParticle(p.x, p.y, "alpha_particle", 1); doDefaults(p); } },
    { id: "radium_226", color: ["#80ff95", "#a3ffb3", "#64e87b"], moltenColor: ["#b8ffc4", "#d4ffdc"], gasColor: ["#a8e6b2", "#c2f2ca"], category: "isotopes", meltTemp: 700, boilTemp: 1737, density: 5500, conduct: 0.5, desc: "Ra-226 -> Rn -> Po-210 -> Pb.", tick: (p) => { p.temp += 0.08; if (Math.random() < 0.004) spawnParticle(p.x, p.y, "alpha_particle", 1); if (Math.random() < 0.00015) { safeChange(p, "radon"); return; } doDefaults(p); } },
    { id: "polonium_210", color: ["#8c9e99", "#9eb0ab"], moltenColor: ["#b5f5d8", "#ccffe8"], gasColor: ["#a8bfb9", "#bcd4ce"], category: "isotopes", meltTemp: 254, boilTemp: 962, density: 9196, conduct: 0.5, desc: "Po-210 -> Lead.", tick: (p) => { p.temp += 0.28; if (Math.random() < 0.008) spawnParticle(p.x, p.y, "alpha_particle", 1); if (Math.random() < 0.0001 && elements.lead) { safeChange(p, "lead"); return; } doDefaults(p); } },
    { id: "barium_141", color: ["#a3a89c", "#b5baa9"], moltenColor: ["#d9b977", "#ebca86"], gasColor: ["#cfd4c7", "#dfe3d8"], category: "isotopes", meltTemp: 727, boilTemp: 1897, density: 3510, conduct: 0.4, behavior: behaviors.POWDER, desc: "Delayed-neutron fission daughter.", tick: (p) => { p.temp += 0.07; if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.00035) spawnNeutronsAround(p.x, p.y, 1, "thermal_neutron"); doDefaults(p); } },
    { id: "strontium_90", color: ["#c2c7b8", "#d3d9c7"], moltenColor: ["#e6c373", "#f2d183"], gasColor: ["#e0e3d8", "#edf0e6"], category: "isotopes", meltTemp: 777, boilTemp: 1382, density: 2640, conduct: 0.45, behavior: behaviors.POWDER, desc: "RTG beta source.", tick: (p) => { p.temp += 0.05; if (Math.random() < 0.002) spawnParticle(p.x, p.y, "beta_particle", 1); doDefaults(p); } },
    { id: "cesium_135", color: ["#d9c27e", "#e6cf8c"], moltenColor: ["#f0d88b", "#fce597"], gasColor: ["#ebdcb0", "#f5e8c1"], category: "isotopes", meltTemp: 28.5, boilTemp: 671, density: 1930, conduct: 0.65, behavior: behaviors.POWDER, desc: "Cesium-135." },
    { id: "beryllium", color: ["#8c9c94", "#9eb0a7", "#7d8c85"], moltenColor: ["#d99b66", "#eba971"], gasColor: ["#b5c4bc", "#c8d6cf"], category: "nuclear", meltTemp: 1287, boilTemp: 2470, density: 1850, conduct: 0.75, hardness: 0.8, desc: "Neutron reflector & multiplier.", reactions: { polonium_210: { chance: 0.03, func: q => { spawnNeutronsAround(q.x, q.y, 1, "fast_neutron"); q.temp += 12; } }, americium_241: { chance: 0.02, func: q => { spawnNeutronsAround(q.x, q.y, 1, "fast_neutron"); q.temp += 8; } } } },
    { id: "boron", color: ["#3a3330", "#4a413d", "#2e2826"], moltenColor: ["#b85e37", "#cc6b41"], gasColor: ["#786c67", "#8a7c76"], category: "nuclear", meltTemp: 2076, boilTemp: 3927, density: 2340, conduct: 0.15, hardness: 0.92, tickAllStates: true, desc: "Control rod & p-B11 fusion fuel (>55k C).", tick: (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 55000 && Math.random() < 0.015 * fr) { const h = findAdj(p, "hydrogen"); if (h) { fusePair(p, h, "helium", "helium", 4500, 80); return; } } doDefaults(p); } },
    { id: "cadmium", color: ["#9da8b8", "#adb8c9", "#8c96a6"], moltenColor: ["#cfd6e0", "#dfe6f0"], gasColor: ["#b8c2d1", "#cbd4e3"], category: "nuclear", meltTemp: 321, boilTemp: 767, density: 8650, conduct: 0.7, hardness: 0.45, desc: "Control-rod neutron absorber." },
    { id: "hafnium", color: ["#7a8491", "#8b95a3", "#697380"], moltenColor: ["#eb9952", "#ffa963"], gasColor: ["#a3adb8", "#b6c0cc"], category: "nuclear", meltTemp: 2233, boilTemp: 4603, density: 13310, conduct: 0.55, hardness: 0.88, desc: "High-temp control rod absorber." },
    { id: "tungsten", color: ["#5b616b", "#6b727d", "#4d525c"], moltenColor: ["#fff3b0", "#fff9d4"], gasColor: ["#a8b0bd", "#bcc4d1"], category: "metals", meltTemp: 3422, boilTemp: 5555, density: 19250, conduct: 0.78, hardness: 0.96, desc: "Highest-melting pure metal (3,422 C)." },
    { id: "lithium_6", color: ["#b8bcc2", "#c7cbd1"], moltenColor: ["#e0c59b", "#f0d4a8"], gasColor: ["#d6dae0", "#e6e9f0"], category: "isotopes", meltTemp: 180.5, boilTemp: 1342, density: 460, conduct: 0.6, hardness: 0.25, desc: "Breeds Tritium + He-4.", reactions: { water: { elem1: "hydrogen", elem2: "fire", chance: 0.22, func: q => { q.temp += 260; } } } },
    { id: "lithium_7", color: ["#aeb3ba", "#bfc4cc"], moltenColor: ["#d9be93", "#e8cca0"], gasColor: ["#cfd4db", "#dfe4eb"], category: "isotopes", meltTemp: 180.5, boilTemp: 1342, density: 534, conduct: 0.6, hardness: 0.25, desc: "Lithium-7.", reactions: { water: { elem1: "hydrogen", elem2: "fire", chance: 0.22, func: q => { q.temp += 260; } } } },
    { id: "nickel", color: ["#a8a89e", "#babab0", "#96968c"], moltenColor: ["#eb9a52", "#ffa961"], gasColor: ["#c7c7bd", "#d9d9cf"], category: "metals", meltTemp: 1455, boilTemp: 2913, density: 8908, conduct: 0.72, hardness: 0.75, behavior: behaviors.POWDER, desc: "Ferromagnetic (Curie: 358 C)." },
    { id: "cobalt", color: ["#587196", "#6682ab", "#4c6282"], moltenColor: ["#e6863e", "#f59851"], gasColor: ["#8da2c2", "#9fb4d4"], category: "metals", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.72, hardness: 0.78, behavior: behaviors.POWDER, desc: "Ferromagnetic (Curie: 1,115 C) -> Co-60." },
    { id: "cobalt_60", color: ["#3b6eff", "#5985ff", "#2c5be6"], moltenColor: ["#7aa2ff", "#99b8ff"], gasColor: ["#6b93ff", "#88a8ff"], category: "isotopes", meltTemp: 1495, boilTemp: 2927, density: 8900, conduct: 0.72, hardness: 0.78, desc: "Gamma emitter.", tick: (p) => { p.temp += 0.16; if (Math.random() < 0.006) spawnParticle(p.x, p.y, "gamma_ray", 1); doDefaults(p); } },
    { id: "neodymium", color: ["#8c929c", "#9da4b0"], moltenColor: ["#eb9b5e", "#ffa96e"], gasColor: ["#b4bac4", "#c5cbd6"], category: "metals", meltTemp: 1024, boilTemp: 3074, density: 7010, conduct: 0.5, hardness: 0.65, behavior: behaviors.POWDER, desc: "Rare-earth metal (Curie: 310 C)." },
    { id: "gadolinium", color: ["#a3b4bd", "#b5c6cf"], moltenColor: ["#e6aa6e", "#f5bb7f"], gasColor: ["#c7d6de", "#d9e6ed"], category: "metals", meltTemp: 1313, boilTemp: 3273, density: 7900, conduct: 0.45, hardness: 0.6, behavior: behaviors.POWDER, desc: "Magnetic thermal switch (Curie: 20 C)." },
    { id: "bismuth", color: ["#c7a4d6", "#9be3d8", "#f0c88c"], moltenColor: ["#d9d4e3", "#ebe6f5"], gasColor: ["#e0d5eb", "#efe6fa"], category: "metals", meltTemp: 271.4, boilTemp: 1564, density: 9780, conduct: 0.25, hardness: 0.4, behavior: behaviors.POWDER, desc: "Room-temp diamagnet." },
    { id: "platinum", color: ["#d6dce3", "#e5ebf2", "#c4cbd4"], moltenColor: ["#ffe1b8", "#ffedd4"], gasColor: ["#e6ecf2", "#f2f7fc"], category: "metals", meltTemp: 1768, boilTemp: 3825, density: 21450, conduct: 0.85, hardness: 0.8, desc: "Catalyzes H2+O2 & Haber Ammonia.", tick: (p) => { if (Math.random() < 0.12) { const h = findAdj(p, "hydrogen"); if (h) { const o = findAdj(p, "oxygen"); if (o) { safeChange(h, "steam"); safeChange(o, "fire"); p.temp += 100; return; } if (p.temp >= 350 && p.temp <= 650 && elements.ammonia) { const n = findAdj(p, "nitrogen"); if (n) { safeChange(h, "ammonia"); safeChange(n, "ammonia"); p.temp += 50; return; } } } } doDefaults(p); } },
    { id: "cesium", color: ["#e3cf86", "#edda95", "#d4bf77"], moltenColor: ["#f5e29d", "#ffedab"], gasColor: ["#f2e6bd", "#fcf1cc"], category: "metals", meltTemp: 28.5, boilTemp: 671, density: 1930, conduct: 0.72, hardness: 0.1, behavior: behaviors.POWDER, desc: "Explodes with water/ice.", reactions: { water: { chance: 0.65, func: q => { safeChange(q, "hydrogen"); q.temp += 1100; explodeAt(q.x, q.y, 4, "fire,hydrogen,steam"); } }, ice: { chance: 0.45, func: q => { safeChange(q, "hydrogen"); explodeAt(q.x, q.y, 4, "fire,hydrogen,steam"); } }, oxygen: { elem1: "fire", elem2: "ash", tempMin: 35, chance: 0.2 } } },
    { id: "rubidium", color: ["#c9cfd6", "#d8dee6"], moltenColor: ["#dfe5ed", "#edf2f7"], gasColor: ["#cfd6de", "#dee4eb"], category: "metals", meltTemp: 39.3, boilTemp: 688, density: 1532, conduct: 0.7, hardness: 0.12, behavior: behaviors.POWDER, desc: "Explodes with water.", reactions: { water: { chance: 0.6, func: q => { safeChange(q, "hydrogen"); explodeAt(q.x, q.y, 3, "fire,hydrogen,steam"); } } } },
    { id: "gallium", color: ["#b4c2d1", "#c5d2e0", "#a4b2c2"], moltenColor: ["#d4e0ed", "#e3edf7"], gasColor: ["#c7d4e3", "#d8e4f2"], category: "metals", meltTemp: 29.8, boilTemp: 2400, density: 5910, conduct: 0.65, hardness: 0.35, desc: "Embrittles Aluminum.", reactions: { aluminum: { elem2: "metal_scrap", chance: 0.14 } } },
    { id: "phosphorus_white", color: ["#f5f0c4", "#fffad1", "#e8e2b0"], moltenColor: ["#fff49e", "#fff9ba"], gasColor: ["#f0ebb9", "#faf5c8"], category: "chemistry", meltTemp: 44.1, boilTemp: 280.5, density: 1823, conduct: 0.05, hardness: 0.2, behavior: behaviors.POWDER, desc: "Pyrophoric (>30 C in O2).", tick: (p) => { if (p.temp >= 250 && p.temp < 400 && Math.random() < 0.02 && !findAdj(p, "oxygen")) { safeChange(p, "phosphorus_red"); return; } doDefaults(p); }, reactions: { oxygen: { elem1: "fire", elem2: "smoke", tempMin: 30, chance: 0.28, func: q => { q.temp += 700; } } } },
    { id: "phosphorus_red", color: ["#9e2b25", "#b5352e", "#87221d"], moltenColor: ["#d94a38", "#eb5a46"], gasColor: ["#f0ebb9", "#faf5c8"], category: "chemistry", meltTemp: 590, boilTemp: 620, density: 2340, conduct: 0.05, hardness: 0.35, behavior: behaviors.POWDER, desc: "Stable Red Phosphorus.", reactions: { oxygen: { elem1: "fire", elem2: "smoke", tempMin: 260, chance: 0.2, func: q => { q.temp += 650; } } } },
    { id: "alumina", color: ["#e8ecf0", "#f2f5f7", "#d8dde3"], moltenColor: ["#ffcf9e", "#ffe0bd"], gasColor: ["#e6eaed", "#f5f8fa"], category: "chemistry", meltTemp: 2072, boilTemp: 2977, density: 3950, conduct: 0.1, hardness: 0.9, behavior: behaviors.POWDER, desc: "Al2O3 Thermite slag." },
    { id: "osmium", color: ["#526075", "#5f6e85", "#465366"], moltenColor: ["#e69653", "#f5a764"], gasColor: ["#7c8ba3", "#8d9cb5"], category: "metals", meltTemp: 3033, boilTemp: 5012, density: 22590, conduct: 0.7, hardness: 0.95, desc: "Densest natural element." }
  ].forEach(defSolid);

  // ---------------------------------------------------------------------------
  // 7. DARK-MODE SETTINGS PANEL + QUIET TOAST + BETTERSETTINGS SYNC
  // ---------------------------------------------------------------------------

  const uiControls = {};
  let statsEl = null, panelEl = null;

  function syncSettingsUI() {
    for (const k of Object.keys(uiControls)) {
      const c = uiControls[k]; if (!c) continue;
      if (c.type === "checkbox") c.checked = !!UPC_CONFIG[k]; else c.value = String(UPC_CONFIG[k]);
      if (c._valLabel) c._valLabel.textContent = String(UPC_CONFIG[k]);
    }
  }

  function applyPreset(name) {
    const P = {
      default: DEFAULT_CONFIG,
      stellar: { gravityMethod: "star", fieldTileSize: 4, fieldRebuildInterval: 2, zeroVanillaGravity: true, gravAccel: 0.036, pressureForceScale: 1.3, compressionHeatScale: 1.3, minBhMass: 75, radiativeCooling: true, collapseThresholdScale: 1.0, showPackGlow: true, starDrag: 0.998, fusionRate: 1.0, supernovaEnabled: true, autoBonding: false },
      reactor: { gravityMethod: "element", fieldTileSize: 4, fieldRebuildInterval: 2, fissionRate: 1.0, fissionHeatScale: 1.0, maxNeutrons: 420, delayedNeutrons: true, plasmaConfinement: true, autoBonding: true },
      fast:    { gravityMethod: "com", fieldTileSize: 6, fieldRebuildInterval: 4, zeroVanillaGravity: true, maxNeutrons: 200, maxBonds: 300, showFields: false, showPackGlow: true }
    };
    if (P[name]) Object.assign(UPC_CONFIG, P[name]);
    applyUPCConfig(true); notifyUser("Preset applied: " + name, true);
  }

  function createSettingsUI() {
    if (typeof document === "undefined" || document.getElementById("upc-settings-btn")) return;
    const style = document.createElement("style");
    style.textContent = "#upc-settings-btn{position:fixed;top:10px;right:12px;z-index:99998;background:#181a22;color:#e6ecff;border:1px solid #3c4663;border-radius:6px;padding:6px 11px;font:600 12px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45)}#upc-settings-btn:hover{background:#232838;border-color:#66b2ff}#upc-settings-panel{position:fixed;top:44px;right:12px;z-index:99999;width:340px;max-height:calc(100vh - 64px);overflow-y:auto;background:rgba(18,20,27,.96);color:#e2e8f5;border:1px solid #343d54;border-radius:9px;padding:12px 14px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.65);display:none}#upc-settings-panel h3{margin:0 0 8px;font-size:14px;color:#7cc4ff;display:flex;justify-content:space-between;align-items:center}#upc-settings-panel .upc-sec{margin:10px 0 5px;padding-top:7px;border-top:1px solid #2b3245;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8c9bbd}#upc-settings-panel .upc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}#upc-settings-panel label{flex:1;color:#d5ddf0}#upc-settings-panel select,#upc-settings-panel input[type=range]{width:136px;background:#101218;color:#eef3ff;border:1px solid #39435e;border-radius:4px;padding:2px 4px;font-size:11.5px}#upc-settings-panel .upc-val{width:38px;text-align:right;color:#8cd1ff;font-variant-numeric:tabular-nums}#upc-settings-panel .upc-presets{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 8px}#upc-settings-panel button.upc-act{background:#23293a;color:#dce6ff;border:1px solid #3a4563;border-radius:5px;padding:5px 7px;font-size:11px;cursor:pointer}#upc-settings-panel button.upc-act:hover{background:#2e3852;border-color:#7cc4ff}#upc-stats-bar{background:#11131a;border:1px solid #272e40;border-radius:5px;padding:6px 8px;font:11px/1.45 ui-monospace,Consolas,monospace;color:#9ad1b8;margin-bottom:6px;white-space:pre-line}#upc-legend{font:10.5px/1.35 system-ui,sans-serif;color:#9eb0d1;margin:2px 0 6px}#upc-toast{position:fixed;bottom:10px;left:12px;z-index:99997;max-width:74vw;background:rgba(16,18,25,.92);color:#d8e6ff;border:1px solid #33405c;border-radius:6px;padding:5px 10px;font:11.5px/1.35 ui-monospace,Consolas,monospace;pointer-events:none;opacity:0;transition:opacity .25s ease}";
    document.head.appendChild(style);

    toastEl = document.createElement("div"); toastEl.id = "upc-toast"; document.body.appendChild(toastEl);
    const btn = document.createElement("button"); btn.id = "upc-settings-btn"; btn.textContent = "Physics Settings"; btn.title = "Unified Physics Settings (Shift+P)"; document.body.appendChild(btn);

    panelEl = document.createElement("div"); panelEl.id = "upc-settings-panel";
    ["mousedown", "mouseup", "click", "wheel", "keydown", "keyup", "touchstart"].forEach(ev => panelEl.addEventListener(ev, e => e.stopPropagation()));
    panelEl.innerHTML = '<h3><span>Unified Physics v13</span><span style="cursor:pointer;color:#7e8ba8" id="upc-close-x">✕</span></h3>';

    statsEl = document.createElement("div"); statsEl.id = "upc-stats-bar"; statsEl.textContent = "Tick: 0.00 ms | MaxPack: 1.0x"; panelEl.appendChild(statsEl);
    const leg = document.createElement("div"); leg.id = "upc-legend"; leg.innerHTML = 'Pack: <span style="color:#41e1ff">Cyan 1.1-1.8x</span> · <span style="color:#ffd437">Gold 1.8-3.5x</span> · <span style="color:#ff6e2a">Orange 3.5-7x</span> · <span style="color:#ff41e1">Magenta 7x+</span> · <span style="color:#f0f8ff">White Wall</span>'; panelEl.appendChild(leg);

    const pRow = document.createElement("div"); pRow.className = "upc-presets";
    [["default", "Balanced Default"], ["stellar", "Stellar / Bounce"], ["reactor", "Reactor & Chem"], ["fast", "High-FPS Mode"]].forEach(([id, txt]) => {
      const b = document.createElement("button"); b.className = "upc-act"; b.textContent = txt; b.onclick = () => applyPreset(id); pRow.appendChild(b);
    });
    panelEl.appendChild(pRow);

    const addSec = (t) => { const d = document.createElement("div"); d.className = "upc-sec"; d.textContent = t; panelEl.appendChild(d); };
    const addSel = (lbl, key, opts) => {
      const r = document.createElement("div"); r.className = "upc-row"; const l = document.createElement("label"); l.textContent = lbl; const s = document.createElement("select");
      opts.forEach(([v, tx]) => { const o = document.createElement("option"); o.value = String(v); o.textContent = tx; s.appendChild(o); });
      s.value = String(UPC_CONFIG[key]); s.onchange = () => { const n = Number(s.value); UPC_CONFIG[key] = Number.isNaN(n) ? s.value : n; applyUPCConfig(true); };
      uiControls[key] = s; r.append(l, s); panelEl.appendChild(r);
    };
    const addSld = (lbl, key, min, max, step) => {
      const r = document.createElement("div"); r.className = "upc-row"; const l = document.createElement("label"); l.textContent = lbl;
      const inp = document.createElement("input"); inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = UPC_CONFIG[key];
      const v = document.createElement("span"); v.className = "upc-val"; v.textContent = String(UPC_CONFIG[key]); inp._valLabel = v;
      inp.oninput = () => { UPC_CONFIG[key] = Number(inp.value); v.textContent = inp.value; applyUPCConfig(true); };
      uiControls[key] = inp; r.append(l, inp, v); panelEl.appendChild(r);
    };
    const addTgl = (lbl, key) => {
      const r = document.createElement("div"); r.className = "upc-row"; const l = document.createElement("label"); l.textContent = lbl;
      const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!UPC_CONFIG[key]; c.onchange = () => { UPC_CONFIG[key] = c.checked; applyUPCConfig(true); };
      uiControls[key] = c; r.append(l, c); panelEl.appendChild(r);
    };

    addSec("Gravity, Pressure & Core Bounce");
    addSel("Gravity Method", "gravityMethod", [["element", "Element-Based (star_gravity/wells)"], ["star", "Multi-Body CIC (Always On)"], ["com", "Fast Center-of-Mass"], ["wells_only", "Gravity Wells / Cores Only"], ["off", "Off (Vanilla Only)"]]);
    addSel("Tile Resolution", "fieldTileSize", [[2, "2x2 (Ultra Sharp)"], [4, "4x4 (Balanced)"], [6, "6x6 (Fast)"], [8, "8x8 (Max FPS)"]]);
    addTgl("Zero-G (Disable Vanilla Fall)", "zeroVanillaGravity");
    addSld("Rebuild Every (ticks)", "fieldRebuildInterval", 1, 6, 1);
    addSld("Gravity Strength", "gravAccel", 0, 0.12, 0.004);
    addSld("Pressure Fight-Back", "pressureForceScale", 0, 3.0, 0.1);
    addSld("Squish Heating Scale", "compressionHeatScale", 0, 2.5, 0.1);
    addSld("Min Black Hole Mass", "minBhMass", 25, 300, 5);
    addSld("Collapse Threshold", "collapseThresholdScale", 0.3, 3.0, 0.1);
    addTgl("Stellar Radiative Cooling", "radiativeCooling");
    addTgl("Compression Color Shift", "showPackGlow");
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
    addTgl("Core Bounce & Collapse", "supernovaEnabled");

    addSec("Chemical Bonding");
    addTgl("Auto Chemical Bonding", "autoBonding");
    addTgl("Render Bond Lines", "showBonds");
    addSld("Max Bond Edges", "maxBonds", 0, 1800, 50);

    const aRow = document.createElement("div"); aRow.className = "upc-presets";
    const cb = document.createElement("button"); cb.className = "upc-act"; cb.textContent = "Break All Bonds"; cb.onclick = () => { clearAllBonds(); notifyUser("Cleared all bonds.", true); };
    const zv = document.createElement("button"); zv.className = "upc-act"; zv.textContent = "Zero All Velocity"; zv.onclick = () => { for (const p of currentPixels) if (p) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; p.inwardImpulse = 0; } movingPixelsLastTick = 0; notifyUser("Zeroed velocity.", true); };
    aRow.append(cb, zv); panelEl.appendChild(aRow); document.body.appendChild(panelEl);

    const toggle = () => { const open = panelEl.style.display === "block"; panelEl.style.display = open ? "none" : "block"; if (!open) syncSettingsUI(); };
    btn.onclick = (e) => { e.stopPropagation(); toggle(); };
    const cx = document.getElementById("upc-close-x"); if (cx) cx.onclick = toggle;
    window.addEventListener("keydown", (e) => { if (e.shiftKey && (e.key === "P" || e.key === "p") && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { e.preventDefault(); toggle(); } });
    setInterval(() => {
      if (panelEl?.style.display === "block" && statsEl) {
        const bhTxt = UPC_STATS.totalBhMass > 0 ? ` | BH:${UPC_STATS.totalBhMass}M` : "";
        statsEl.textContent = `Tick: ${UPC_STATS.lastTickMs.toFixed(2)} ms | MaxPack: ${UPC_STATS.maxPack.toFixed(1)}x${bhTxt}\nTile:${activeFieldBlock}px G:${UPC_STATS.activeGravTiles} B:${UPC_STATS.activeMagTiles} | Bonds:${UPC_STATS.activeBonds} | n:${UPC_STATS.activeNeutrons}\nStatus: ${UPC_STATS.lastEvent}`;
      }
    }, 450);
  }

  function registerBetterSettingsTab() {
    if (typeof SettingsTab !== "function" || typeof settingsManager === "undefined") return;
    try {
      const tab = new SettingsTab("Unified Physics");
      const bind = (s, k) => { if (s?.onUpdate) s.onUpdate(v => { UPC_CONFIG[k] = v; applyUPCConfig(true); }); if (tab.registerSetting) tab.registerSetting(s); };
      bind(new SelectSetting("Gravity Method", "upc_grav_method", [["element", "Element-Based"], ["star", "Multi-Body CIC"], ["com", "Fast Center-of-Mass"], ["wells_only", "Wells/Cores Only"], ["off", "Off"]]), "gravityMethod");
      bind(new SelectSetting("Tile Size", "upc_tile_size", [[2, "2x2"], [4, "4x4"], [6, "6x6"], [8, "8x8"]]), "fieldTileSize");
      if (typeof Setting === "function" && typeof settingType !== "undefined") {
        bind(new Setting("Zero-G Space Mode", "upc_zero_g", settingType.BOOLEAN, false, UPC_CONFIG.zeroVanillaGravity), "zeroVanillaGravity");
        bind(new Setting("Compression Color Shift", "upc_pack_glow", settingType.BOOLEAN, false, UPC_CONFIG.showPackGlow), "showPackGlow");
        bind(new Setting("Auto Bonding", "upc_auto_bond", settingType.BOOLEAN, false, UPC_CONFIG.autoBonding), "autoBonding");
        bind(new Setting("Show Field Vectors", "upc_show_fields", settingType.BOOLEAN, false, UPC_CONFIG.showFields), "showFields");
      }
      settingsManager.registerTab(tab);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 8. INIT: PATCH VANILLA & CHEM.JS + CRASH-PROOF ZERO-G + OZONE FIX
  // ---------------------------------------------------------------------------

  function initUnifiedPhysics() {
    applyUPCConfig(false);

    if (!elements.iron_gas) reg("iron_gas", { color: ["#ffb870", "#ffc98f"], behavior: behaviors.GAS, category: "states", state: "gas", hidden: true, density: 7.8, temp: 2950, tempLow: 2862, stateLow: "molten_iron" });
    if (elements.molten_iron && !elements.molten_iron.stateHigh) { elements.molten_iron.tempHigh = 2862; elements.molten_iron.stateHigh = "iron_gas"; }

    if (elements.neutron) { elements.neutron.desc = "Free neutron (Unified Physics v13)."; if (!elements.neutron.reactions) elements.neutron.reactions = {}; delete elements.neutron.tick1; delete elements.neutron.tick2; elements.neutron.tick = (p) => neutronTick(p, true); }
    if (elements.uranium) { elements.uranium.desc = "Natural/LEU Uranium (patched)."; delete elements.uranium.tick1; delete elements.uranium.tick2; elements.uranium.tick = (p) => { if (Math.random() < 0.00003) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); }; }
    if (elements.plutonium) { elements.plutonium.desc = "Plutonium-239 (patched)."; delete elements.plutonium.tick1; delete elements.plutonium.tick2; elements.plutonium.tick = (p) => { p.temp += 0.03; if (Math.random() < 0.00012) spawnNeutronsAround(p.x, p.y, 1, "fast_neutron"); doDefaults(p); }; }

    // Cap Oxygen -> Ozone <= 350 C and decompose hot Ozone -> Oxygen
    for (const k in elements) {
      const rx = elements[k]?.reactions; if (!rx) continue;
      for (const rk in rx) {
        const r = rx[rk];
        if (r && typeof r === "object" && (k === "oxygen" || rk === "oxygen") && (r.elem1 === "ozone" || r.elem2 === "ozone")) {
          r.tempMax = 350; if (r.chance === undefined || r.chance > 0.04) r.chance = 0.04;
        }
      }
    }
    if (elements.ozone) wrapTick("ozone", (p) => (p.temp >= 350 && Math.random() < (p.temp >= 800 ? 0.65 : 0.14) ? (safeChange(p, "oxygen"), true) : false));

    // Realistic Stellar Fusion Hierarchy: Slow H Main Sequence (16k C) -> Accelerating He (68k) -> O (125k) -> Si (155k)
    if (elements.hydrogen) wrapTick("hydrogen", (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 16000 && Math.random() < 0.0016 * fr) { const o = findAdj(p, "hydrogen"); if (o) { fusePair(p, o, "deuterium", "positron", 1100, 90); return true; } } return false; });
    if (elements.helium) wrapTick("helium", (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 68000 && Math.random() < 0.007 * fr) { const o = findAdj(p, "helium"); if (o) { fusePair(p, o, "carbon_vapor", "gamma_ray", 2400, 75); return true; } } return false; });
    if (elements.oxygen) wrapTick("oxygen", (p) => { const fr = getFusionFactor(p); if (fr > 0 && p.temp >= 125000 && Math.random() < 0.032 * fr) { const o = findAdj(p, "oxygen"); if (o) { fusePair(p, o, Math.random() < 0.75 ? "silicon_gas" : (elements.sulfur_gas ? "sulfur_gas" : "silicon_gas"), "gamma_ray", 2500, 75); return true; } } return false; });

    // Thermal dissociation, Thermite & chem.js UO2
    if (elements.carbon_dioxide) wrapTick("carbon_dioxide", (p) => (p.temp >= 4000 && Math.random() < 0.08 ? (safeChange(p, Math.random() < 0.5 ? "carbon_vapor" : "oxygen"), true) : false));
    if (elements.steam) wrapTick("steam", (p) => (p.temp >= 3200 && Math.random() < 0.07 ? (safeChange(p, Math.random() < 0.66 ? "hydrogen" : "oxygen"), true) : false));
    if (elements.ammonia) wrapTick("ammonia", (p) => (p.temp >= 1200 && Math.random() < 0.08 ? (safeChange(p, Math.random() < 0.75 ? "hydrogen" : "nitrogen"), true) : false));
    if (elements.sand) wrapTick("sand", (p) => (p.temp >= 4500 && Math.random() < 0.06 ? (safeChange(p, Math.random() < 0.45 ? "silicon_gas" : "oxygen"), true) : false));
    if (elements.rust && elements.aluminum) safeAddReaction("rust", "aluminum", { elem1: "molten_iron", elem2: "alumina", tempMin: 1200, chance: 0.22, func: (a, b) => { a.temp += 1500; b.temp += 1500; } });
    if (elements.uranium_dioxide) FISSILE.uranium_dioxide = { th: 0.16, fa: 0.015, n: [2, 3], h: 1200, d: ["barium_141", "krypton_92", "xenon_135"] };

    // Crash-proof Zero-G hook using safeReact
    if (typeof window !== "undefined" && typeof window.tryMove === "function" && !window.tryMove._upcWrapped) {
      const origMove = window.tryMove;
      const wrappedMove = function (p, nx, ny, lb, force) {
        if (inVanillaTick && starModeActive && UPC_CONFIG.zeroVanillaGravity && p && !p.del && !force) {
          const st = elements[p.element]?.state;
          if (st === "gas") {
            if (ny !== p.y && Math.random() < 0.75) { const d = randomDir(); nx = p.x + d[0]; ny = p.y + d[1]; }
            if (!inSafeBounds(nx, ny)) return false;
            if (isEmpty(nx, ny)) return origMove.call(this, p, nx, ny, lb, force);
            safeReact(p, pixelMap[nx][ny]);
            return false;
          }
          if (st !== "energy") {
            if (inSafeBounds(nx, ny) && !isEmpty(nx, ny)) safeReact(p, pixelMap[nx][ny]);
            return false;
          }
        }
        return origMove.call(this, p, nx, ny, lb, force);
      };
      wrappedMove._upcWrapped = true; window.tryMove = wrappedMove;
    }

    if (typeof window !== "undefined" && typeof window.tickPixels === "function" && !window.tickPixels._upcWrapped) {
      const origTick = window.tickPixels;
      const wrappedTick = function (...args) {
        let res; inVanillaTick = true;
        try { res = origTick.apply(this, args); } finally { inVanillaTick = false; }
        const t0 = performance.now();
        try { updateGravityAndCompressionTick(); updateBondsTick(); } catch (e) { console.error("[UPC] tick:", e); }
        UPC_STATS.lastTickMs = performance.now() - t0;
        return res;
      };
      wrappedTick._upcWrapped = true; window.tickPixels = wrappedTick;
    }

    if (typeof window !== "undefined" && typeof window.drawPixels === "function" && !window.drawPixels._upcWrapped) {
      const origDraw = window.drawPixels;
      const wrappedDraw = function (...args) {
        const res = origDraw.apply(this, args);
        try { drawFieldOverlay(); drawBlackHoleAurasAndRadGlow(); drawActiveBonds(); } catch (e) {}
        return res;
      };
      wrappedDraw._upcWrapped = true; window.drawPixels = wrappedDraw;
    }

    function sanitizeTicks() {
      const fixed = [];
      for (const k in elements) {
        const el = elements[k]; if (!el || el.tool) continue;
        if (el.tick !== undefined && typeof el.tick !== "function") delete el.tick;
        const b1 = typeof el.tick1 === "function" && (el.tick1 === el.tick || String(el.tick1).includes("tick1"));
        const b2 = typeof el.tick2 === "function" && (el.tick2 === el.tick || String(el.tick2).includes("tick1") || String(el.tick2).includes("tick2"));
        if (b1 || b2) { fixed.push(k); if (!b2 && typeof el.tick2 === "function") el.tick = el.tick2; else if (!b1 && typeof el.tick1 === "function") el.tick = el.tick1; else delete el.tick; delete el.tick1; delete el.tick2; }
        if (!el.reactions) el.reactions = {};
        if (!el.behavior && !el.tick) el.behavior = el.state === "liquid" ? behaviors.LIQUID : el.state === "gas" ? behaviors.GAS : behaviors.WALL;
      }
      if (fixed.length) console.warn("[UPC] Broke recursive tick1 loop on:", fixed);
    }

    sanitizeTicks(); setTimeout(sanitizeTicks, 250);
    createSettingsUI();
    if (typeof SettingsTab === "function") registerBetterSettingsTab();
    else if (typeof dependOn === "function") dependOn("betterSettings.js", registerBetterSettingsTab, true);

    console.log("[unified_physics_chem] Loaded v13 successfully!");
  }

  if (typeof runAfterLoad === "function") runAfterLoad(initUnifiedPhysics);
  else initUnifiedPhysics();
})();
