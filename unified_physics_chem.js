/*
 * Unified Physics & Chemistry v4 (unified_physics_chem.js)
 * Complete drop-in companion add-on for Sandboxels + chem.js
 *
 * Key Architecture & Fixes:
 *  - External Map-based Chemical Bond Graph (ZERO circular references on Pixel objects; Undo/Save safe)
 *  - Built-in Dark-Mode In-Game Settings Panel ("Physics" button or Shift+P) + localStorage persistence
 *  - Optional automatic betterSettings.js tab registration
 *  - Customizable 2x2 / 4x4 / 6x6 / 8x8 Gravity-Tile & Magnetic-Tile Precomputed Kernel Engine
 *  - Deterministic Per-Pixel Velocity, Momentum Collisions & Circular Orbit Launcher
 *  - True N/S Magnetism, Curie Points, Bismuth Diamagnetism, Meissner Levitation & Tokamak Confinement
 *  - Complete Stellar & Reactor Fusion Ladder (D-T through Silicon -> Ni-56 -> Co-56 -> Fe -> Supernova r-process)
 *  - Crash-Proof Neutron-Transport Fission + Distinct Alpha, Beta & Gamma Radiation + Decay Chains
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. LIVE CUSTOMIZABLE CONFIGURATION & PERSISTENCE
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "upc_v4_settings";

  const DEFAULT_CONFIG = {
    gravityMethod: "element",     // "element" | "star" | "com" | "wells_only" | "off"
    fieldTileSize: 4,             // 2 | 4 | 6 | 8
    fieldRebuildInterval: 2,      // 1..6 ticks
    gravAccel: 0.032,             // 0..0.15
    magScale: 1.0,                // 0..3.0
    maxSpeed: 2.6,                // 0.5..3.5
    starDrag: 0.996,              // 0.90..1.00
    fusionRate: 1.0,              // 0..3.0
    fissionHeatScale: 1.0,        // 0.2..3.0
    maxNeutrons: 320,             // 40..800
    maxBonds: 700,                // 0..2000
    autoBonding: true,
    showBonds: true,
    showFields: false,
    plasmaConfinement: true,
    supernovaEnabled: true,
    curieDemagnetize: true,
    delayedNeutrons: true
  };

  const UPC_CONFIG = Object.assign({}, DEFAULT_CONFIG);

  function loadSavedConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (parsed[k] !== undefined && parsed[k] !== null) {
          UPC_CONFIG[k] = parsed[k];
        }
      }
    } catch (e) {}
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(UPC_CONFIG));
    } catch (e) {}
  }

  loadSavedConfig();

  // Active runtime values synced from UPC_CONFIG
  let FIELD_BLOCK = 4;
  let FIELD_SOFTENING = 0.85;
  let FIELD_REBUILD_INTERVAL = 2;
  let MAX_SPEED = 2.6;
  let GRAV_ACCEL = 0.032;
  let MAG_POLE_ACCEL = 0.18;
  let MAG_FERRO_ACCEL = 0.55;
  let MAG_MEISSNER_ACCEL = 0.72;
  let MAG_DIAMAG_ACCEL = 0.14;
  let MAG_PLASMA_ACCEL = 0.45;
  let MAX_NEUTRONS = 320;
  let MAX_BONDS = 700;
  let activeFieldBlock = 0;

  // Live telemetry stats for the Settings HUD
  const UPC_STATS = {
    lastTickMs: 0,
    activeGravTiles: 0,
    activeMagTiles: 0,
    movingPixels: 0,
    activeNeutrons: 0,
    activeBonds: 0
  };

  function applyUPCConfig(persist = true) {
    const newBlock = Math.max(2, Math.min(8, parseInt(UPC_CONFIG.fieldTileSize, 10) || 4));
    if (newBlock !== FIELD_BLOCK) {
      FIELD_BLOCK = newBlock;
      kernelX = null; // Trigger clean kernel/tile reallocation
    }
    FIELD_REBUILD_INTERVAL = Math.max(1, Math.min(6, parseInt(UPC_CONFIG.fieldRebuildInterval, 10) || 2));
    GRAV_ACCEL = Math.max(0, Math.min(0.25, Number(UPC_CONFIG.gravAccel)));
    if (Number.isNaN(GRAV_ACCEL)) GRAV_ACCEL = DEFAULT_CONFIG.gravAccel;

    const ms = Math.max(0, Math.min(4, Number(UPC_CONFIG.magScale)));
    const safeMs = Number.isNaN(ms) ? 1.0 : ms;
    MAG_POLE_ACCEL = 0.18 * safeMs;
    MAG_FERRO_ACCEL = 0.55 * safeMs;
    MAG_MEISSNER_ACCEL = 0.72 * safeMs;
    MAG_DIAMAG_ACCEL = 0.14 * safeMs;
    MAG_PLASMA_ACCEL = 0.45 * safeMs;

    MAX_SPEED = Math.max(0.5, Math.min(3.5, Number(UPC_CONFIG.maxSpeed) || 2.6));
    MAX_NEUTRONS = Math.max(40, Math.min(800, parseInt(UPC_CONFIG.maxNeutrons, 10) || 320));
    MAX_BONDS = Math.max(0, Math.min(2000, parseInt(UPC_CONFIG.maxBonds, 10) || 700));
    UPC_CONFIG.starDrag = Math.max(0.85, Math.min(1.0, Number(UPC_CONFIG.starDrag) || 0.996));
    UPC_CONFIG.fusionRate = Math.max(0, Math.min(3.0, Number(UPC_CONFIG.fusionRate)));
    if (Number.isNaN(UPC_CONFIG.fusionRate)) UPC_CONFIG.fusionRate = 1.0;
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
  // 2. CORE SAFETY UTILITIES & FULL STATE-CHAIN BUILDERS
  // ---------------------------------------------------------------------------

  const NON_ZERO_DIRS = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1]
  ];

  function randomDir() {
    return NON_ZERO_DIRS[Math.floor(Math.random() * NON_ZERO_DIRS.length)];
  }

  function inSafeBounds(x, y) {
    return !outOfBounds(x, y) && pixelMap[x] !== undefined;
  }

  function notifyUser(msg) {
    if (typeof logMessage === "function") {
      logMessage(msg);
    } else {
      console.log("[unified_physics_chem]", msg);
    }
  }

  function safeChange(pixel, elemName) {
    if (!pixel || pixel.del || !elements[elemName]) return false;
    changePixel(pixel, elemName);
    return true;
  }

  function safeChangeAny(pixel, candidates) {
    if (!pixel || pixel.del) return false;
    for (let i = 0; i < candidates.length; i++) {
      if (elements[candidates[i]]) {
        changePixel(pixel, candidates[i]);
        return true;
      }
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
    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    if (!inSafeBounds(x1, y1) || !inSafeBounds(x2, y2)) return false;
    p1.x = x2; p1.y = y2;
    p2.x = x1; p2.y = y1;
    pixelMap[x1][y1] = p2;
    pixelMap[x2][y2] = p1;
    return true;
  }

  function findAdjacentElement(pixel, targetNameOrSet) {
    const start = Math.floor(Math.random() * adjacentCoords.length);
    const isSet = targetNameOrSet instanceof Set;
    for (let i = 0; i < adjacentCoords.length; i++) {
      const idx = (start + i) % adjacentCoords.length;
      const nx = pixel.x + adjacentCoords[idx][0];
      const ny = pixel.y + adjacentCoords[idx][1];
      if (!inSafeBounds(nx, ny)) continue;
      const other = pixelMap[nx][ny];
      if (!other || other.del) continue;
      if (isSet ? targetNameOrSet.has(other.element) : other.element === targetNameOrSet) {
        return other;
      }
    }
    return null;
  }

  function safeAddReaction(elemName, targetName, reactionObj) {
    if (!elements[elemName]) return;
    if (!elements[elemName].reactions) elements[elemName].reactions = {};
    elements[elemName].reactions[targetName] = reactionObj;
  }

  function wrapTick(elemName, extraFn) {
    const el = elements[elemName];
    if (!el || el.tool) return;
    const prevTick = typeof el.tick === "function" ? el.tick : null;
    el.tick = function (pixel) {
      if (!pixel || pixel.del) return;
      if (extraFn(pixel) === true) return;
      if (pixel.del) return;
      if (prevTick) prevTick(pixel);
      else doDefaults(pixel);
    };
  }

  function registerOrEnhance(name, def) {
    const clean = {};
    for (const key of Object.keys(def)) {
      if (key === "_override") continue;
      if (key === "tick" && typeof def[key] !== "function") continue;
      if (def[key] === undefined || def[key] === null) continue;
      clean[key] = def[key];
    }
    if (!clean.tool && !clean.reactions) clean.reactions = {};

    if (elements[name]) {
      const existing = elements[name];
      if (clean.reactions) {
        existing.reactions = Object.assign({}, existing.reactions || {}, clean.reactions);
      }
      for (const key of Object.keys(clean)) {
        if (key === "reactions") continue;
        if (existing[key] === undefined || def._override) {
          existing[key] = clean[key];
        }
      }
    } else {
      elements[name] = clean;
    }
  }

  function defineFullElement(cfg) {
    const {
      id,
      color,
      moltenColor,
      gasColor,
      category = "solids",
      meltTemp,
      boilTemp,
      density,
      conduct = 0.5,
      hardness = 0.7,
      behavior = behaviors.WALL,
      reactions = {},
      tick,
      tickAllStates = false,
      desc = "",
      extra = {}
    } = cfg;

    const moltenId = "molten_" + id;
    const gasId = id + "_gas";
    const hasTick = typeof tick === "function";

    const solidDef = Object.assign({
      color,
      behavior,
      category,
      state: "solid",
      density,
      conduct,
      hardness,
      tempHigh: meltTemp,
      stateHigh: moltenId,
      reactions: Object.assign({}, reactions),
      desc
    }, extra);
    if (hasTick) solidDef.tick = tick;
    registerOrEnhance(id, solidDef);

    const moltenDef = {
      color: moltenColor || ["#ff7b29", "#ff9e3d", "#ffb84d"],
      behavior: behaviors.LIQUID,
      category: "states",
      state: "liquid",
      hidden: true,
      density: Math.round(density * 0.9),
      conduct: conduct * 0.8,
      temp: meltTemp + 50,
      tempLow: meltTemp,
      stateLow: id,
      tempHigh: boilTemp,
      stateHigh: gasId,
      viscosity: 14,
      reactions: Object.assign({}, reactions)
    };
    if (hasTick) moltenDef.tick = tick;
    registerOrEnhance(moltenId, moltenDef);

    const gasDef = {
      color: gasColor || ["#d9d9d9", "#bfbfbf"],
      behavior: behaviors.GAS,
      category: "states",
      state: "gas",
      hidden: true,
      density: Math.max(0.5, +(density / 1000).toFixed(2)),
      temp: boilTemp + 50,
      tempLow: boilTemp,
      stateLow: moltenId,
      reactions: Object.assign({}, reactions)
    };
    if (hasTick && tickAllStates) gasDef.tick = tick;
    registerOrEnhance(gasId, gasDef);
  }

  function defineFullGas(cfg) {
    const {
      id,
      color,
      liquidColor,
      solidColor,
      category = "gases",
      boilTemp,
      meltTemp,
      density,
      reactions = {},
      tick,
      desc = "",
      extra = {}
    } = cfg;

    const liquidId = "liquid_" + id;
    const solidId = "solid_" + id;
    const hasTick = typeof tick === "function";

    const gasDef = Object.assign({
      color,
      behavior: behaviors.GAS,
      category,
      state: "gas",
      density,
      tempLow: boilTemp,
      stateLow: liquidId,
      reactions: Object.assign({}, reactions),
      desc
    }, extra);
    if (hasTick) gasDef.tick = tick;
    registerOrEnhance(id, gasDef);

    const liquidDef = {
      color: liquidColor || color,
      behavior: behaviors.LIQUID,
      category: "states",
      state: "liquid",
      hidden: true,
      density: Math.max(50, Math.round(density * 600)),
      temp: boilTemp - 5,
      tempHigh: boilTemp,
      stateHigh: id,
      tempLow: meltTemp,
      stateLow: solidId,
      reactions: Object.assign({}, reactions)
    };
    if (hasTick) liquidDef.tick = tick;
    registerOrEnhance(liquidId, liquidDef);

    const solidDef = {
      color: solidColor || liquidColor || color,
      behavior: behaviors.WALL,
      category: "states",
      state: "solid",
      hidden: true,
      density: Math.max(80, Math.round(density * 750)),
      temp: meltTemp - 5,
      tempHigh: meltTemp,
      stateHigh: liquidId,
      reactions: Object.assign({}, reactions)
    };
    if (hasTick) solidDef.tick = tick;
    registerOrEnhance(solidId, solidDef);
  }

  // ---------------------------------------------------------------------------
  // 3. EXTERNAL-GRAPH CHEMICAL BONDING ENGINE (100% JSON / UNDO / SAVE SAFE!)
  // ---------------------------------------------------------------------------

  // Stored completely OUTSIDE Pixel instances so JSON.stringify() in generateSave/historyLog
  // never encounters a circular reference.
  const bondGraph = new Map(); // Map<Pixel, Array<{ target: Pixel, type: string, breakTemp: number }>>
  let totalBondEdges = 0;

  const RADIOLYSIS_AGENTS = new Set([
    "radiation", "fast_neutron", "alpha_particle", "beta_particle", "gamma_ray"
  ]);

  const AUTO_BOND_RULES = {
    "hydrogen|hydrogen":   { type: "covalent", breakTemp: 3500, minTemp: -250, maxTemp: 2500, prob: 0.08, maxValenceA: 1, maxValenceB: 1 },
    "hydrogen|oxygen":     { type: "polar",    breakTemp: 2800, minTemp: 120,  maxTemp: 2200, prob: 0.14, maxValenceA: 1, maxValenceB: 2 },
    "deuterium|oxygen":    { type: "polar",    breakTemp: 2850, minTemp: 120,  maxTemp: 2200, prob: 0.14, maxValenceA: 1, maxValenceB: 2 },
    "chlorine|sodium":     { type: "ionic",    breakTemp: 1450, minTemp: -50,  maxTemp: 1100, prob: 0.22, maxValenceA: 1, maxValenceB: 1 },
    "chlorine|hydrogen":   { type: "polar",    breakTemp: 2200, minTemp: -100, maxTemp: 1600, prob: 0.14, maxValenceA: 1, maxValenceB: 1 },
    "nitrogen|nitrogen":   { type: "covalent", breakTemp: 5500, minTemp: -200, maxTemp: 4000, prob: 0.06, maxValenceA: 1, maxValenceB: 1 },
    "hydrogen|nitrogen":   { type: "polar",    breakTemp: 1300, minTemp: 350,  maxTemp: 900,  prob: 0.08, maxValenceA: 1, maxValenceB: 3 },
    "carbon_vapor|oxygen": { type: "covalent", breakTemp: 3800, minTemp: 600,  maxTemp: 3200, prob: 0.12, maxValenceA: 2, maxValenceB: 2 },
    "graphite|graphite":   { type: "covalent", breakTemp: 4200, minTemp: 800,  maxTemp: 3400, prob: 0.04, maxValenceA: 3, maxValenceB: 3 },
    "silicon|silicon":     { type: "covalent", breakTemp: 2600, minTemp: 200,  maxTemp: 2200, prob: 0.04, maxValenceA: 4, maxValenceB: 4 },
    "oxygen|silicon":      { type: "covalent", breakTemp: 3000, minTemp: 700,  maxTemp: 2400, prob: 0.10, maxValenceA: 2, maxValenceB: 4 },
    "magnesium|oxygen":    { type: "ionic",    breakTemp: 2800, minTemp: 400,  maxTemp: 2300, prob: 0.18, maxValenceA: 2, maxValenceB: 2 },
    "cesium|chlorine":     { type: "ionic",    breakTemp: 1300, minTemp: -50,  maxTemp: 900,  prob: 0.25, maxValenceA: 1, maxValenceB: 1 },
    "iron|oxygen":         { type: "ionic",    breakTemp: 2200, minTemp: 300,  maxTemp: 1600, prob: 0.06, maxValenceA: 2, maxValenceB: 2 },
    "aluminum|oxygen":     { type: "ionic",    breakTemp: 2900, minTemp: 500,  maxTemp: 2400, prob: 0.08, maxValenceA: 3, maxValenceB: 2 }
  };

  function getBondKey(e1, e2) {
    return e1 < e2 ? e1 + "|" + e2 : e2 + "|" + e1;
  }

  function getBonds(p) {
    return bondGraph.get(p) || null;
  }

  function getBondCount(p) {
    const arr = bondGraph.get(p);
    return arr ? arr.length : 0;
  }

  function hasBondBetween(p1, p2) {
    const arr = bondGraph.get(p1);
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].target === p2) return true;
    }
    return false;
  }

  function createBond(p1, p2, type = "covalent", breakTemp = 2500) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del) return false;
    if (totalBondEdges >= MAX_BONDS) return false;
    if (hasBondBetween(p1, p2)) return false;

    let b1 = bondGraph.get(p1);
    let b2 = bondGraph.get(p2);
    if ((b1 && b1.length >= 4) || (b2 && b2.length >= 4)) return false;

    if (!b1) { b1 = []; bondGraph.set(p1, b1); }
    if (!b2) { b2 = []; bondGraph.set(p2, b2); }

    b1.push({ target: p2, type, breakTemp });
    b2.push({ target: p1, type, breakTemp });
    totalBondEdges++;

    p1.temp += 18;
    p2.temp += 18;
    return true;
  }

  function breakBondBetween(p1, p2, endothermic = true) {
    let removed = false;
    const b1 = bondGraph.get(p1);
    if (b1) {
      for (let i = b1.length - 1; i >= 0; i--) {
        if (b1[i].target === p2) {
          b1.splice(i, 1);
          removed = true;
        }
      }
      if (b1.length === 0) bondGraph.delete(p1);
    }
    const b2 = bondGraph.get(p2);
    if (b2) {
      for (let i = b2.length - 1; i >= 0; i--) {
        if (b2[i].target === p1) {
          b2.splice(i, 1);
          removed = true;
        }
      }
      if (b2.length === 0) bondGraph.delete(p2);
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
    const copy = arr.slice();
    for (let i = 0; i < copy.length; i++) {
      breakBondBetween(pixel, copy[i].target, false);
    }
  }

  function clearAllBonds() {
    bondGraph.clear();
    totalBondEdges = 0;
  }

  const IMMOBILE_SPECIAL = new Set([
    "gravity_well", "star_gravity", "neutronium", "black_hole_core", "field_visualizer"
  ]);

  function isImmobileElement(elemName) {
    const el = elements[elemName];
    if (!el) return true;
    return el.behavior === behaviors.WALL || IMMOBILE_SPECIAL.has(elemName);
  }

  function stepToward(mover, targetX, targetY) {
    if (!mover || mover.del || isImmobileElement(mover.element)) return false;
    const dx = Math.sign(targetX - mover.x);
    const dy = Math.sign(targetY - mover.y);
    if (dx === 0 && dy === 0) return false;

    const candidates = [
      [mover.x + dx, mover.y + dy],
      [mover.x + dx, mover.y],
      [mover.x, mover.y + dy]
    ];
    for (let i = 0; i < candidates.length; i++) {
      const nx = candidates[i][0], ny = candidates[i][1];
      if (!inSafeBounds(nx, ny)) continue;
      if (isEmpty(nx, ny)) {
        movePixel(mover, nx, ny);
        return true;
      }
      const occ = pixelMap[nx][ny];
      if (occ && !occ.del && !isImmobileElement(occ.element)) {
        const occState = elements[occ.element]?.state;
        if (occState === "gas" || occState === "liquid") {
          return safeSwap(mover, occ);
        }
      }
    }
    return false;
  }

  function updateBondsTick() {
    if (bondGraph.size > 0) {
      const toVisit = Array.from(bondGraph.keys());
      for (let i = 0; i < toVisit.length; i++) {
        const p = toVisit[i];
        const pBonds = bondGraph.get(p);
        if (!p || p.del || !pBonds || pBonds.length === 0 || !inSafeBounds(p.x, p.y) || pixelMap[p.x][p.y] !== p) {
          breakAllBonds(p);
          bondGraph.delete(p);
          continue;
        }

        let hitBreaker = false;
        let hitRad = false;
        let hitWater = false;
        for (let c = 0; c < adjacentCoords.length; c++) {
          const ax = p.x + adjacentCoords[c][0];
          const ay = p.y + adjacentCoords[c][1];
          if (!inSafeBounds(ax, ay)) continue;
          const adj = pixelMap[ax][ay];
          if (!adj || adj.del) continue;
          if (adj.element === "bond_breaker") hitBreaker = true;
          else if (RADIOLYSIS_AGENTS.has(adj.element)) hitRad = true;
          else if (adj.element === "water") hitWater = true;
        }

        if (hitBreaker) {
          breakAllBonds(p);
          continue;
        }

        for (let j = pBonds.length - 1; j >= 0; j--) {
          const bond = pBonds[j];
          const t = bond.target;

          if (!t || t.del || !inSafeBounds(t.x, t.y) || pixelMap[t.x][t.y] !== t) {
            breakBondBetween(p, t, false);
            continue;
          }

          const dist = Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y));

          // 1. Mechanical shear
          if (dist > 3) { breakBondBetween(p, t, true); continue; }
          // 2. Thermal cleavage
          if (p.temp > bond.breakTemp || t.temp > bond.breakTemp) { breakBondBetween(p, t, true); continue; }
          // 3. Electrolysis / electrical cleavage
          if ((p.charge && p.charge > 0) || (t.charge && t.charge > 0)) {
            if (bond.type === "ionic" || bond.type === "polar" || Math.random() < 0.4) {
              breakBondBetween(p, t, true);
              continue;
            }
          }
          // 4. Radiolysis
          if (hitRad && Math.random() < 0.35) { breakBondBetween(p, t, true); continue; }
          // 5. Ionic solvation in water
          if (bond.type === "ionic" && hitWater && Math.random() < 0.18) { breakBondBetween(p, t, true); continue; }

          // Heat conduction & shared velocity across the bond
          const avgT = (p.temp + t.temp) * 0.5;
          p.temp += (avgT - p.temp) * 0.25;
          t.temp += (avgT - t.temp) * 0.25;

          if (!isImmobileElement(p.element) && !isImmobileElement(t.element)) {
            const pvx = p.vx || 0, pvy = p.vy || 0;
            const tvx = t.vx || 0, tvy = t.vy || 0;
            if (pvx || pvy || tvx || tvy) {
              const avx = (pvx + tvx) * 0.5;
              const avy = (pvy + tvy) * 0.5;
              p.vx = pvx + (avx - pvx) * 0.4;
              p.vy = pvy + (avy - pvy) * 0.4;
              t.vx = tvx + (avx - tvx) * 0.4;
              t.vy = tvy + (avy - tvy) * 0.4;
            }
          }

          if (dist > 1) {
            const pDens = elements[p.element]?.density || 1000;
            const tDens = elements[t.element]?.density || 1000;
            if (!isImmobileElement(p.element) && (isImmobileElement(t.element) || pDens <= tDens)) {
              stepToward(p, t.x, t.y);
            } else {
              stepToward(t, p.x, p.y);
            }
          }
        }
      }
    }

    // Automatic chemical bond formation sampling (respects live UPC_CONFIG.autoBonding)
    if (UPC_CONFIG.autoBonding && totalBondEdges < MAX_BONDS && currentPixels && currentPixels.length > 0) {
      const samples = Math.min(85, currentPixels.length);
      for (let s = 0; s < samples; s++) {
        if (totalBondEdges >= MAX_BONDS) break;
        const p = currentPixels[Math.floor(Math.random() * currentPixels.length)];
        if (!p || p.del || getBondCount(p) >= 3) continue;

        const dir = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        const nx = p.x + dir[0], ny = p.y + dir[1];
        if (!inSafeBounds(nx, ny)) continue;
        const q = pixelMap[nx][ny];
        if (!q || q.del || getBondCount(q) >= 3) continue;

        const key = getBondKey(p.element, q.element);
        const rule = AUTO_BOND_RULES[key];
        if (!rule) continue;

        const avgTemp = (p.temp + q.temp) * 0.5;
        if (avgTemp < rule.minTemp || avgTemp > rule.maxTemp) continue;

        const firstIsA = p.element <= q.element;
        const maxA = firstIsA ? rule.maxValenceA : rule.maxValenceB;
        const maxB = firstIsA ? rule.maxValenceB : rule.maxValenceA;
        if (getBondCount(p) >= maxA || getBondCount(q) >= maxB) continue;

        if (Math.random() < rule.prob) {
          createBond(p, q, rule.type, rule.breakTemp);
        }
      }
    }

    UPC_STATS.activeBonds = totalBondEdges;
  }

  function drawActiveBonds() {
    if (!UPC_CONFIG.showBonds || bondGraph.size === 0) return;
    if (typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;

    ctx.save();
    ctx.lineWidth = Math.max(1, pixelSize * 0.26);
    ctx.lineCap = "round";

    bondGraph.forEach(function (bonds, p) {
      if (!p || p.del || !bonds) return;
      for (let i = 0; i < bonds.length; i++) {
        const bond = bonds[i];
        const t = bond.target;
        if (!t || t.del) continue;
        if (p.x > t.x || (p.x === t.x && p.y >= t.y)) continue;

        if (bond.type === "ionic") ctx.strokeStyle = "rgba(255, 215, 90, 0.88)";
        else if (bond.type === "polar") ctx.strokeStyle = "rgba(110, 225, 255, 0.88)";
        else if (bond.type === "catalyst") ctx.strokeStyle = "rgba(140, 255, 130, 0.92)";
        else ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";

        ctx.beginPath();
        ctx.moveTo((p.x + 0.5) * pixelSize, (p.y + 0.5) * pixelSize);
        ctx.lineTo((t.x + 0.5) * pixelSize, (t.y + 0.5) * pixelSize);
        ctx.stroke();
      }
    });

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 4. UNIFIED GRAVITY-TILE & MAGNETIC-TILE ENGINE + PER-PIXEL VELOCITY
  // ---------------------------------------------------------------------------

  const IRON_FAMILY = new Set(["iron", "molten_iron", "iron_gas"]);
  const SUPER_R_PROCESS_TARGETS = new Set([
    "iron", "molten_iron", "iron_gas",
    "nickel", "molten_nickel", "nickel_gas",
    "cobalt", "molten_cobalt"
  ]);
  const R_PROCESS_PRODUCTS = [
    "gold", "platinum", "lead", "thorium_232", "uranium_238", "uranium_235", "plutonium_239"
  ];

  const FERROMAGNETIC_CURIE = {
    iron: 770,
    molten_iron: 770,
    iron_filings: 770,
    steel: 750,
    cobalt: 1115,
    cobalt_60: 1115,
    nickel: 358,
    neodymium: 310,
    gadolinium: 20, // Magnetic switch right at room temp (20 C)!
    rust: 580,
    metal_scrap: 750
  };

  const MAGNET_POLE_MAP = {
    magnet_north: 1,
    magnet_south: -1,
    neodymium_north: 1,
    neodymium_south: -1,
    electromagnet_north: 1,
    electromagnet_south: -1,
    magnet_bead_n: 1,
    magnet_bead_s: -1
  };

  const MAGNET_STRENGTH = {
    magnet_north: 1.0,
    magnet_south: -1.0,
    neodymium_north: 2.2,
    neodymium_south: -2.2,
    electromagnet_north: 1.9,
    electromagnet_south: -1.9,
    magnet_bead_n: 0.45,
    magnet_bead_s: -0.45
  };

  const PLASMA_CONFINABLE = new Set([
    "plasma", "hydrogen", "deuterium", "tritium", "helium", "helium_3",
    "carbon_vapor", "oxygen", "neon", "silicon_gas"
  ]);

  const VELOCITY_EXEMPT = new Set([
    "fast_neutron", "thermal_neutron", "radiation",
    "alpha_particle", "beta_particle", "gamma_ray",
    "bond_breaker", "bond_catalyst"
  ]);

  let fieldMw = 0, fieldMh = 0, fieldKw = 0;
  let kernelX = null, kernelY = null, kernelPhi = null;

  let macroMass = null, macroGx = null, macroGy = null, macroPhi = null;
  let macroIron = null, macroHotIron = null;

  let macroPole = null, macroMagAbs = null;
  let macroBx = null, macroBy = null, macroMagPot = null, macroBmag = null;
  let macroGradBx = null, macroGradBy = null;

  let lastFieldTick = -100;
  let lastSupernovaTick = -200;
  let gravFieldActive = false;
  let magFieldActive = false;
  let starModeActive = false;
  let visualizerActive = false;
  let movingPixelsLastTick = 0;

  function isFerromagneticNow(pixel) {
    const curie = FERROMAGNETIC_CURIE[pixel.element];
    if (curie === undefined) return false;
    return !UPC_CONFIG.curieDemagnetize || pixel.temp <= curie;
  }

  function ensureFieldTables() {
    if (typeof width !== "number" || typeof height !== "number") return false;
    const mw = Math.max(2, Math.ceil((width + 1) / FIELD_BLOCK));
    const mh = Math.max(2, Math.ceil((height + 1) / FIELD_BLOCK));
    if (mw === fieldMw && mh === fieldMh && FIELD_BLOCK === activeFieldBlock && kernelX) return true;

    activeFieldBlock = FIELD_BLOCK;
    fieldMw = mw;
    fieldMh = mh;
    const kw = 2 * mw - 1;
    const kh = 2 * mh - 1;
    fieldKw = kw;

    kernelX = new Float32Array(kw * kh);
    kernelY = new Float32Array(kw * kh);
    kernelPhi = new Float32Array(kw * kh);

    // Precompute unit-source pull vectors & potential once per tile resolution
    for (let dy = -(mh - 1); dy <= mh - 1; dy++) {
      const rowOff = (dy + mh - 1) * kw;
      for (let dx = -(mw - 1); dx <= mw - 1; dx++) {
        const idx = rowOff + (dx + mw - 1);
        const r2 = dx * dx + dy * dy + FIELD_SOFTENING;
        const invR = 1 / Math.sqrt(r2);
        const invR3 = invR * invR * invR;
        kernelX[idx] = -dx * invR3;
        kernelY[idx] = -dy * invR3;
        kernelPhi[idx] = invR;
      }
    }

    const total = mw * mh;
    macroMass = new Float32Array(total);
    macroGx = new Float32Array(total);
    macroGy = new Float32Array(total);
    macroPhi = new Float32Array(total);
    macroIron = new Uint16Array(total);
    macroHotIron = new Uint16Array(total);

    macroPole = new Float32Array(total);
    macroMagAbs = new Float32Array(total);
    macroBx = new Float32Array(total);
    macroBy = new Float32Array(total);
    macroMagPot = new Float32Array(total);
    macroBmag = new Float32Array(total);
    macroGradBx = new Float32Array(total);
    macroGradBy = new Float32Array(total);
    return true;
  }

  function sampleField(arr, x, y) {
    if (!arr || fieldMw < 2 || fieldMh < 2) return 0;
    const fx = x / FIELD_BLOCK - 0.5;
    const fy = y / FIELD_BLOCK - 0.5;
    const x0 = Math.max(0, Math.min(fieldMw - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(fieldMh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));

    const r0 = y0 * fieldMw + x0;
    const r1 = r0 + fieldMw;
    const top = arr[r0] + (arr[r0 + 1] - arr[r0]) * tx;
    const bot = arr[r1] + (arr[r1 + 1] - arr[r1]) * tx;
    return top + (bot - top) * ty;
  }

  function sampleFieldMinusSelf(arr, x, y, selfBx, selfBy, selfCoeff, kArr) {
    if (!arr || !kArr || fieldMw < 2 || fieldMh < 2) return 0;
    const fx = x / FIELD_BLOCK - 0.5;
    const fy = y / FIELD_BLOCK - 0.5;
    const x0 = Math.max(0, Math.min(fieldMw - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(fieldMh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));

    const r0 = y0 * fieldMw + x0;
    const r1 = r0 + fieldMw;
    const kRow0 = (y0 - selfBy + fieldMh - 1) * fieldKw + (x0 - selfBx + fieldMw - 1);
    const kRow1 = kRow0 + fieldKw;

    const v00 = arr[r0]     + selfCoeff * kArr[kRow0];
    const v10 = arr[r0 + 1] + selfCoeff * kArr[kRow0 + 1];
    const v01 = arr[r1]     + selfCoeff * kArr[kRow1];
    const v11 = arr[r1 + 1] + selfCoeff * kArr[kRow1 + 1];

    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
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
        if (p && !p.del) {
          safeChange(p, coreElem);
          p.temp = 130000;
        } else if (isEmpty(nx, ny)) {
          const np = safeCreate(coreElem, nx, ny);
          if (np) np.temp = 130000;
        }
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

        if (SUPER_R_PROCESS_TARGETS.has(p.element) && Math.random() < 0.45) {
          const heavy = R_PROCESS_PRODUCTS[Math.floor(Math.random() * R_PROCESS_PRODUCTS.length)];
          safeChange(p, heavy);
        }

        if (!isImmobileElement(p.element)) {
          const kick = Math.min(MAX_SPEED, 15 / dist);
          p.vx = (p.vx || 0) + (dx / dist) * kick;
          p.vy = (p.vy || 0) + (dy / dist) * kick;
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

    macroMass.fill(0);
    macroGx.fill(0);
    macroGy.fill(0);
    macroPhi.fill(0);
    macroIron.fill(0);
    macroHotIron.fill(0);

    macroPole.fill(0);
    macroMagAbs.fill(0);
    macroBx.fill(0);
    macroBy.fill(0);
    macroMagPot.fill(0);

    let hasStarGravity = false;
    let hasPointWell = false;
    let hasMagnets = false;
    let hasVisualizer = false;

    // Pass 1: Sum mass & magnetic pole strength into each tile
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del) continue;
      const e = p.element;

      if (e === "star_gravity") { hasStarGravity = true; continue; }
      if (e === "field_visualizer") { hasVisualizer = true; continue; }

      const bx = (p.x / FIELD_BLOCK) | 0;
      const by = (p.y / FIELD_BLOCK) | 0;
      if (bx < 0 || bx >= fieldMw || by < 0 || by >= fieldMh) continue;
      const bIdx = by * fieldMw + bx;

      const magStr = MAGNET_STRENGTH[e];
      if (magStr !== undefined) {
        const isElectro = e === "electromagnet_north" || e === "electromagnet_south";
        if (!isElectro || (p.charge && p.charge > 0)) {
          macroPole[bIdx] += magStr;
          macroMagAbs[bIdx] += Math.abs(magStr);
          hasMagnets = true;
        }
      }

      if (e === "gravity_well") {
        hasPointWell = true;
        macroMass[bIdx] += 48;
      } else if (e === "neutronium") {
        hasPointWell = true;
        macroMass[bIdx] += 105;
      } else if (e === "black_hole_core") {
        hasPointWell = true;
        macroMass[bIdx] += 210;
      } else if (!isImmobileElement(e)) {
        const dens = elements[e]?.density || 100;
        macroMass[bIdx] += Math.min(12, Math.max(0.35, dens / 1000));
        if (IRON_FAMILY.has(e)) {
          macroIron[bIdx]++;
          if (p.temp > 85000) macroHotIron[bIdx]++;
        }
      }
    }

    // Apply user-selected Gravity Method
    const mode = UPC_CONFIG.gravityMethod;
    if (mode === "off") {
      hasStarGravity = false;
      hasPointWell = false;
      macroMass.fill(0);
    } else if (mode === "star") {
      hasStarGravity = true;
    } else if (mode === "wells_only") {
      hasStarGravity = false;
    } else if (mode === "com") {
      let totalM = 0, sumX = 0, sumY = 0;
      for (let by = 0; by < fieldMh; by++) {
        const row = by * fieldMw;
        for (let bx = 0; bx < fieldMw; bx++) {
          const m = macroMass[row + bx];
          if (m > 0) { totalM += m; sumX += bx * m; sumY += by * m; }
        }
      }
      macroMass.fill(0);
      if (totalM > 0) {
        const cx = Math.min(fieldMw - 1, Math.max(0, Math.round(sumX / totalM)));
        const cy = Math.min(fieldMh - 1, Math.max(0, Math.round(sumY / totalM)));
        macroMass[cy * fieldMw + cx] = totalM;
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
        if (e !== "gravity_well" && e !== "neutronium" && e !== "black_hole_core") continue;
        const bx = (p.x / FIELD_BLOCK) | 0;
        const by = (p.y / FIELD_BLOCK) | 0;
        if (bx >= 0 && bx < fieldMw && by >= 0 && by < fieldMh) {
          macroMass[by * fieldMw + bx] += e === "black_hole_core" ? 210 : (e === "neutronium" ? 105 : 48);
        }
      }
    }

    UPC_STATS.activeGravTiles = 0;
    UPC_STATS.activeMagTiles = 0;
    if (!gravFieldActive && !magFieldActive) return;

    // Normalize pull strength when tile resolution changes so gravity feels consistent at 2x2..8x8
    const tileScale = (FIELD_BLOCK * FIELD_BLOCK) / 16;

    // Pass 2: Convolve non-empty tiles with precomputed lookup kernels
    const mw = fieldMw, mh = fieldMh, kw = fieldKw;
    for (let sy = 0; sy < mh; sy++) {
      const sRow = sy * mw;
      for (let sx = 0; sx < mw; sx++) {
        const sIdx = sRow + sx;
        const m = gravFieldActive ? macroMass[sIdx] * tileScale : 0;
        const q = magFieldActive ? macroPole[sIdx] * tileScale : 0;
        const qAbs = magFieldActive ? macroMagAbs[sIdx] * tileScale : 0;
        if (m > 0) UPC_STATS.activeGravTiles++;
        if (qAbs > 0) UPC_STATS.activeMagTiles++;
        if (m <= 0 && q === 0 && qAbs <= 0) continue;

        const kxBase = mw - 1 - sx;
        if (m > 0 && qAbs > 0) {
          for (let ty = 0; ty < mh; ty++) {
            let gIdx = ty * mw;
            let kIdx = (ty - sy + mh - 1) * kw + kxBase;
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              const kx = kernelX[kIdx], ky = kernelY[kIdx], kp = kernelPhi[kIdx];
              macroGx[gIdx] += m * kx;
              macroGy[gIdx] += m * ky;
              macroPhi[gIdx] += m * kp;
              macroBx[gIdx] -= q * kx;
              macroBy[gIdx] -= q * ky;
              macroMagPot[gIdx] += qAbs * kp;
            }
          }
        } else if (m > 0) {
          for (let ty = 0; ty < mh; ty++) {
            let gIdx = ty * mw;
            let kIdx = (ty - sy + mh - 1) * kw + kxBase;
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              macroGx[gIdx] += m * kernelX[kIdx];
              macroGy[gIdx] += m * kernelY[kIdx];
              macroPhi[gIdx] += m * kernelPhi[kIdx];
            }
          }
        } else {
          for (let ty = 0; ty < mh; ty++) {
            let gIdx = ty * mw;
            let kIdx = (ty - sy + mh - 1) * kw + kxBase;
            for (let tx = 0; tx < mw; tx++, gIdx++, kIdx++) {
              macroBx[gIdx] -= q * kernelX[kIdx];
              macroBy[gIdx] -= q * kernelY[kIdx];
              macroMagPot[gIdx] += qAbs * kernelPhi[kIdx];
            }
          }
        }
      }
    }

    // Pass 2b: |B| and gradient for ferromagnets, Meissner & plasma confinement
    if (magFieldActive) {
      const total = mw * mh;
      for (let i = 0; i < total; i++) {
        macroBmag[i] = Math.hypot(macroBx[i], macroBy[i]) + 0.25 * macroMagPot[i];
      }
      for (let by = 0; by < mh; by++) {
        const row = by * mw;
        const yPrev = by > 0 ? (by - 1) * mw : row;
        const yNext = by < mh - 1 ? (by + 1) * mw : row;
        for (let bx = 0; bx < mw; bx++) {
          const idx = row + bx;
          const xPrev = bx > 0 ? bx - 1 : bx;
          const xNext = bx < mw - 1 ? bx + 1 : bx;
          macroGradBx[idx] = (macroBmag[row + xNext] - macroBmag[row + xPrev]) * 0.5;
          macroGradBy[idx] = (macroBmag[yNext + bx] - macroBmag[yPrev + bx]) * 0.5;
        }
      }
    }

    // Pass 2c: Local iron-core collapse check (Supernova / Hypernova)
    if (gravFieldActive && UPC_CONFIG.supernovaEnabled) {
      for (let by = 1; by < mh - 1; by++) {
        for (let bx = 1; bx < mw - 1; bx++) {
          const idx = by * mw + bx;
          if (macroIron[idx] < 6) continue;
          let ironSum = 0, hotSum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nIdx = (by + dy) * mw + (bx + dx);
              ironSum += macroIron[nIdx];
              hotSum += macroHotIron[nIdx];
            }
          }
          if ((ironSum >= 18 && hotSum >= 8) || (ironSum >= 28 && macroPhi[idx] > 40)) {
            const makeBlackHole = ironSum >= 45 || macroPhi[idx] > 140;
            triggerSupernova(bx * FIELD_BLOCK + (FIELD_BLOCK >> 1), by * FIELD_BLOCK + (FIELD_BLOCK >> 1), makeBlackHole);
            return;
          }
        }
      }
    }
  }

  function advancePixelByVelocity(p) {
    let remX = Math.trunc(p.rx);
    let remY = Math.trunc(p.ry);
    if (remX === 0 && remY === 0) return;

    p.rx -= remX;
    p.ry -= remY;

    const steps = Math.min(3, Math.max(Math.abs(remX), Math.abs(remY)));
    const pDens = elements[p.element]?.density || 1000;

    for (let s = 0; s < steps; s++) {
      if (p.del) return;
      const sx = Math.sign(remX);
      const sy = Math.sign(remY);
      if (sx === 0 && sy === 0) break;

      const nx = p.x + sx;
      const ny = p.y + sy;

      if (!inSafeBounds(nx, ny)) {
        if (sx !== 0) p.vx = 0;
        if (sy !== 0) p.vy = 0;
        p.rx = 0; p.ry = 0;
        break;
      }

      if (isEmpty(nx, ny)) {
        movePixel(p, nx, ny);
        remX -= sx;
        remY -= sy;
        continue;
      }

      if (sx !== 0 && sy !== 0) {
        if (inSafeBounds(p.x + sx, p.y) && isEmpty(p.x + sx, p.y)) {
          movePixel(p, p.x + sx, p.y);
          remX -= sx;
          p.vy *= 0.5;
          continue;
        }
        if (inSafeBounds(p.x, p.y + sy) && isEmpty(p.x, p.y + sy)) {
          movePixel(p, p.x, p.y + sy);
          remY -= sy;
          p.vx *= 0.5;
          continue;
        }
      }

      const target = pixelMap[nx][ny];
      if (!target || target.del) break;

      if (!isImmobileElement(target.element)) {
        const tInfo = elements[target.element];
        const tDens = tInfo?.density || 1000;
        const tState = tInfo?.state;

        if ((tState === "gas" || tState === "liquid") && pDens > tDens * 1.15) {
          safeSwap(p, target);
          p.vx *= 0.88;
          p.vy *= 0.88;
          remX -= sx;
          remY -= sy;
          continue;
        }

        const totalM = pDens + tDens;
        const tvx = target.vx || 0, tvy = target.vy || 0;
        const relSpd = Math.hypot(p.vx - tvx, p.vy - tvy);
        if (relSpd > 1.2) {
          const heat = Math.round(relSpd * 35);
          p.temp += heat;
          target.temp += heat;
        }
        const newVx = (pDens * p.vx + tDens * tvx) / totalM;
        const newVy = (pDens * p.vy + tDens * tvy) / totalM;
        p.vx = newVx * 0.82;
        p.vy = newVy * 0.82;
        target.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, tvx + (newVx - tvx) * 1.15));
        target.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, tvy + (newVy - tvy) * 1.15));
        break;
      } else {
        if (sx !== 0) p.vx = Math.abs(p.vx) > 1.2 ? -p.vx * 0.25 : 0;
        if (sy !== 0) p.vy = Math.abs(p.vy) > 1.2 ? -p.vy * 0.25 : 0;
        p.vx *= 0.85;
        p.vy *= 0.85;
        break;
      }
    }
  }

  function updateGravityAndCompressionTick() {
    if (!currentPixels || currentPixels.length === 0) return;

    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t - lastFieldTick >= FIELD_REBUILD_INTERVAL) {
      lastFieldTick = t;
      rebuildFields();
    }

    if (!gravFieldActive && !magFieldActive && movingPixelsLastTick === 0) {
      UPC_STATS.movingPixels = 0;
      return;
    }

    const tileScale = (FIELD_BLOCK * FIELD_BLOCK) / 16;
    const subtractSelfGrav = starModeActive && UPC_CONFIG.gravityMethod !== "com";
    let movingNow = 0;

    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del || isImmobileElement(p.element)) continue;
      if (VELOCITY_EXEMPT.has(p.element)) continue;

      let ax = 0;
      let ay = 0;
      const selfBx = (p.x / FIELD_BLOCK) | 0;
      const selfBy = (p.y / FIELD_BLOCK) | 0;

      // 1. Multi-Body Gravity + Adiabatic Compression Heating
      if (gravFieldActive) {
        const selfM = subtractSelfGrav
          ? Math.min(12, Math.max(0.35, (elements[p.element]?.density || 100) / 1000)) * tileScale
          : 0;
        const gx = selfM > 0
          ? sampleFieldMinusSelf(macroGx, p.x, p.y, selfBx, selfBy, -selfM, kernelX)
          : sampleField(macroGx, p.x, p.y);
        const gy = selfM > 0
          ? sampleFieldMinusSelf(macroGy, p.x, p.y, selfBx, selfBy, -selfM, kernelY)
          : sampleField(macroGy, p.x, p.y);

        const radPressure = p.temp > 45000 ? Math.min(0.65, (p.temp - 45000) / 140000) : 0;
        const gScale = GRAV_ACCEL * (1 - radPressure);
        ax += gx * gScale;
        ay += gy * gScale;

        if ((t & 1) === 0) {
          const phi = sampleField(macroPhi, p.x, p.y);
          if (phi > 12) {
            let surrounded = 0;
            for (let c = 0; c < adjacentCoords.length; c++) {
              const cx = p.x + adjacentCoords[c][0];
              const cy = p.y + adjacentCoords[c][1];
              if (inSafeBounds(cx, cy) && !isEmpty(cx, cy)) surrounded++;
            }
            p.pressure = Math.round(phi * surrounded * 0.65);
            if (surrounded >= 5) {
              p.temp += phi * surrounded * 0.38;
              if (p.element === "graphite" && p.pressure > 260 && p.temp > 1500 && elements.diamond) {
                safeChange(p, "diamond");
              }
            }
          }
        }
      }

      // 2. Unified Magnetic Field
      if (magFieldActive) {
        const poleSign = MAGNET_POLE_MAP[p.element];
        if (poleSign !== undefined) {
          const selfQ = (MAGNET_STRENGTH[p.element] || 0) * tileScale;
          const bxVal = sampleFieldMinusSelf(macroBx, p.x, p.y, selfBx, selfBy, selfQ, kernelX);
          const byVal = sampleFieldMinusSelf(macroBy, p.x, p.y, selfBx, selfBy, selfQ, kernelY);
          ax += poleSign * bxVal * MAG_POLE_ACCEL;
          ay += poleSign * byVal * MAG_POLE_ACCEL;
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

      const prevVx = p.vx || 0;
      const prevVy = p.vy || 0;
      if (ax === 0 && ay === 0 && prevVx === 0 && prevVy === 0) continue;

      const drag = starModeActive ? UPC_CONFIG.starDrag : 0.94;
      let vx = (prevVx + ax) * drag;
      let vy = (prevVy + ay) * drag;

      const spd2 = vx * vx + vy * vy;
      if (spd2 > MAX_SPEED * MAX_SPEED) {
        const scale = MAX_SPEED / Math.sqrt(spd2);
        vx *= scale;
        vy *= scale;
      }
      if (Math.abs(vx) < 0.015) vx = 0;
      if (Math.abs(vy) < 0.015) vy = 0;

      p.vx = vx;
      p.vy = vy;

      if (vx !== 0 || vy !== 0) {
        movingNow++;
        p.rx = (p.rx || 0) + vx;
        p.ry = (p.ry || 0) + vy;
        advancePixelByVelocity(p);
      }
    }

    movingPixelsLastTick = movingNow;
    UPC_STATS.movingPixels = movingNow;
  }

  function drawFieldOverlay() {
    if (!visualizerActive || (!gravFieldActive && !magFieldActive)) return;
    if (typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;

    ctx.save();
    ctx.lineWidth = Math.max(1, pixelSize * 0.22);

    const stepPx = FIELD_BLOCK * pixelSize;
    for (let by = 0; by < fieldMh; by++) {
      for (let bx = 0; bx < fieldMw; bx++) {
        const idx = by * fieldMw + bx;
        const cx = (bx + 0.5) * stepPx;
        const cy = (by + 0.5) * stepPx;

        if (magFieldActive) {
          const bvx = macroBx[idx], bvy = macroBy[idx];
          const bLen = Math.hypot(bvx, bvy);
          if (bLen > 0.15) {
            const drawL = Math.min(stepPx * 0.45, Math.log1p(bLen) * stepPx * 0.22);
            ctx.strokeStyle = "rgba(0, 235, 255, 0.55)";
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + (bvx / bLen) * drawL, cy + (bvy / bLen) * drawL);
            ctx.stroke();
          }
        }

        if (gravFieldActive) {
          const gvx = macroGx[idx], gvy = macroGy[idx];
          const gLen = Math.hypot(gvx, gvy);
          if (gLen > 0.4) {
            const drawL = Math.min(stepPx * 0.45, Math.log1p(gLen) * stepPx * 0.16);
            ctx.strokeStyle = "rgba(255, 196, 61, 0.50)";
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + (gvx / gLen) * drawL, cy + (gvy / gLen) * drawL);
            ctx.stroke();
          }
        }
      }
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 5. NUCLEAR FISSION & IONIZING RADIATION ENGINE
  // ---------------------------------------------------------------------------

  const MODERATOR_PROB = {
    water: 0.55,
    ice: 0.50,
    heavy_water: 0.45,
    heavy_ice: 0.42,
    graphite: 0.35,
    paraffin: 0.52
  };
  const REFLECTORS = new Set(["beryllium", "molten_beryllium", "tungsten", "steel"]);
  const POISONS = new Set(["boron", "molten_boron", "cadmium", "molten_cadmium", "hafnium", "molten_hafnium", "xenon_135"]);
  const HIGH_Z_SHIELD = new Set(["lead", "molten_lead", "tungsten", "osmium", "uranium_238", "concrete"]);
  const BETA_SHIELD = new Set(["aluminum", "iron", "steel", "copper", "glass", "lead", "tungsten", "osmium", "concrete", "titanium"]);

  const MAX_SPAWN_PER_TICK = 40;
  const MAX_IONIZING = 220;
  const EXPLODE_COOLDOWN_TICKS = 8;

  let lastPhysicsTick = -1;
  let neutronsThisTick = 0;
  let prevTickNeutrons = 0;
  let spawnedThisTick = 0;
  let ionizingThisTick = 0;
  let lastExplodeTick = -100;
  let loggedNeutronError = false;

  function syncPhysicsTick() {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t !== lastPhysicsTick) {
      prevTickNeutrons = neutronsThisTick;
      UPC_STATS.activeNeutrons = neutronsThisTick;
      neutronsThisTick = 0;
      spawnedThisTick = 0;
      ionizingThisTick = 0;
      lastPhysicsTick = t;
    }
  }

  const FISSILE_SPECS = {
    uranium_235:         { thermalProb: 0.78, fastProb: 0.08, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    molten_uranium_235:  { thermalProb: 0.72, fastProb: 0.07, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    plutonium_239:       { thermalProb: 0.82, fastProb: 0.24, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    molten_plutonium_239:{ thermalProb: 0.78, fastProb: 0.22, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    uranium_233:         { thermalProb: 0.80, fastProb: 0.14, neutrons: [2, 3], heat: 2300, daughters: ["barium_141", "krypton_92", "strontium_90"] },
    molten_uranium_233:  { thermalProb: 0.75, fastProb: 0.12, neutrons: [2, 3], heat: 2300, daughters: ["barium_141", "krypton_92", "strontium_90"] },
    uranium:             { thermalProb: 0.35, fastProb: 0.03, neutrons: [2, 2], heat: 1600, daughters: ["barium_141", "krypton_92", "xenon_135"] },
    plutonium:           { thermalProb: 0.82, fastProb: 0.24, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90"] },
    enriched_uranium:    { thermalProb: 0.76, fastProb: 0.08, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] }
  };

  function spawnParticle(cx, cy, elemName, count = 1) {
    syncPhysicsTick();
    if (!elements[elemName] || ionizingThisTick >= MAX_IONIZING) return;
    const dirs = NON_ZERO_DIRS.slice();
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    let spawned = 0;
    for (let d = 0; d < dirs.length && spawned < count; d++) {
      if (ionizingThisTick >= MAX_IONIZING) break;
      const dx = dirs[d][0], dy = dirs[d][1];
      const nx = cx + dx, ny = cy + dy;
      if (inSafeBounds(nx, ny) && isEmpty(nx, ny)) {
        const np = safeCreate(elemName, nx, ny);
        if (np) {
          np.vx = dx;
          np.vy = dy;
          np.life = elemName === "alpha_particle" ? 18 : (elemName === "beta_particle" ? 55 : 90);
          spawned++;
          ionizingThisTick++;
        }
      }
    }
  }

  function spawnNeutronsAround(cx, cy, count, type = "fast_neutron") {
    syncPhysicsTick();
    if (!elements[type]) return;
    if (prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS) return;
    if (spawnedThisTick >= MAX_SPAWN_PER_TICK) return;

    const dirs = NON_ZERO_DIRS.slice();
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }

    let spawned = 0;
    for (let d = 0; d < dirs.length && spawned < count; d++) {
      if (prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS || spawnedThisTick >= MAX_SPAWN_PER_TICK) break;
      const dx = dirs[d][0], dy = dirs[d][1];
      for (let dist = 1; dist <= 2; dist++) {
        const nx = cx + dx * dist, ny = cy + dy * dist;
        if (!inSafeBounds(nx, ny)) break;
        if (isEmpty(nx, ny)) {
          const np = safeCreate(type, nx, ny);
          if (np) {
            np.vx = dx;
            np.vy = dy;
            np.life = 95;
          }
          spawned++;
          spawnedThisTick++;
          break;
        }
      }
    }
  }

  function triggerFission(targetPixel, spec, neutronPixel) {
    syncPhysicsTick();
    if (!targetPixel || targetPixel.del) return;
    const tx = targetPixel.x;
    const ty = targetPixel.y;

    const daughter = spec.daughters[Math.floor(Math.random() * spec.daughters.length)];
    safeChange(targetPixel, daughter);

    const heatAmt = Math.round(spec.heat * UPC_CONFIG.fissionHeatScale);
    targetPixel.temp += heatAmt;
    let nearbyFissile = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const nx = tx + dx, ny = ty + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (p && !p.del) {
          p.temp += Math.round(heatAmt * 0.18);
          if (FISSILE_SPECS[p.element]) nearbyFissile++;
        }
      }
    }

    if (neutronPixel && !neutronPixel.del && inSafeBounds(neutronPixel.x, neutronPixel.y) && pixelMap[neutronPixel.x][neutronPixel.y] === neutronPixel) {
      deletePixel(neutronPixel.x, neutronPixel.y);
    }

    const nCount = spec.neutrons[0] + (Math.random() < 0.5 ? (spec.neutrons[1] - spec.neutrons[0]) : 0);
    spawnNeutronsAround(tx, ty, nCount, "fast_neutron");
    if (Math.random() < 0.3) spawnParticle(tx, ty, "gamma_ray", 1);

    if (targetPixel.temp > 6000 && nearbyFissile >= 10 && (lastPhysicsTick - lastExplodeTick >= EXPLODE_COOLDOWN_TICKS)) {
      lastExplodeTick = lastPhysicsTick;
      explodeAt(tx, ty, 8, "plasma,fire,radiation,fallout");
    }
  }

  function ionizingParticleTick(pixel, kind) {
    if (!pixel || pixel.del) return;
    syncPhysicsTick();
    ionizingThisTick++;
    if (ionizingThisTick > MAX_IONIZING * 1.4) {
      deletePixel(pixel.x, pixel.y);
      return;
    }

    if (!pixel.vx && !pixel.vy) {
      const d = randomDir();
      pixel.vx = d[0];
      pixel.vy = d[1];
    }
    if (pixel.life === undefined) pixel.life = kind === "alpha" ? 18 : (kind === "beta" ? 55 : 90);
    pixel.life--;

    if (pixel.life <= 0) {
      if (kind === "alpha" && Math.random() < 0.35 && elements.helium) safeChange(pixel, "helium");
      else deletePixel(pixel.x, pixel.y);
      return;
    }

    const steps = kind === "gamma" ? 3 : (kind === "beta" ? 2 : 1);
    for (let s = 0; s < steps; s++) {
      if (pixel.del) return;
      const nx = pixel.x + pixel.vx;
      const ny = pixel.y + pixel.vy;
      if (!inSafeBounds(nx, ny)) { deletePixel(pixel.x, pixel.y); return; }
      if (isEmpty(nx, ny)) { movePixel(pixel, nx, ny); continue; }

      const target = pixelMap[nx][ny];
      if (!target || target === pixel || target.del) continue;
      const tElem = target.element;
      const tState = elements[tElem]?.state;

      if (kind === "alpha") {
        if (tElem === "beryllium" || tElem === "molten_beryllium") {
          spawnNeutronsAround(target.x, target.y, 1, "fast_neutron");
          target.temp += 80;
          deletePixel(pixel.x, pixel.y);
          return;
        }
        if (tState === "gas") {
          safeSwap(pixel, target);
          target.temp += 5;
        } else {
          target.temp += 45;
          if (Math.random() < 0.25 && elements.helium) safeChange(pixel, "helium");
          else deletePixel(pixel.x, pixel.y);
          return;
        }
      } else if (kind === "beta") {
        if (BETA_SHIELD.has(tElem)) {
          target.temp += 22;
          deletePixel(pixel.x, pixel.y);
          return;
        }
        target.temp += 6;
        safeSwap(pixel, target);
      } else {
        if (HIGH_Z_SHIELD.has(tElem) && Math.random() < 0.55) {
          target.temp += 35;
          deletePixel(pixel.x, pixel.y);
          return;
        }
        target.temp += 10;
        safeSwap(pixel, target);
      }
    }
  }

  function neutronTick(pixel, isFast) {
    try {
      if (!pixel || pixel.del) return;
      syncPhysicsTick();
      neutronsThisTick++;

      if (neutronsThisTick > MAX_NEUTRONS * 1.25) {
        deletePixel(pixel.x, pixel.y);
        return;
      }

      if (!pixel.vx && !pixel.vy) {
        const d = randomDir();
        pixel.vx = d[0];
        pixel.vy = d[1];
      }
      if (pixel.life === undefined) pixel.life = 95;
      pixel.life--;

      if (pixel.life <= 0) {
        safeChangeAny(pixel, ["proton", "hydrogen"]);
        return;
      }

      const steps = isFast ? 2 : 1;
      for (let s = 0; s < steps; s++) {
        if (pixel.del) return;
        const nx = pixel.x + pixel.vx;
        const ny = pixel.y + pixel.vy;

        if (!inSafeBounds(nx, ny)) {
          deletePixel(pixel.x, pixel.y);
          return;
        }

        if (isEmpty(nx, ny)) {
          movePixel(pixel, nx, ny);
          continue;
        }

        const target = pixelMap[nx][ny];
        if (!target || target === pixel || target.del) continue;
        const tElem = target.element;

        // A. Fission + Doppler feedback
        if (FISSILE_SPECS[tElem]) {
          const spec = FISSILE_SPECS[tElem];
          let prob = isFast ? spec.fastProb : spec.thermalProb;
          if (!isFast && target.temp > 1200) {
            prob *= Math.max(0.65, 1 - (target.temp - 1200) / 10000);
          }
          if (Math.random() < prob) {
            triggerFission(target, spec, pixel);
            return;
          } else {
            if (Math.random() < 0.5) safeSwap(pixel, target);
            else { pixel.vx = -pixel.vx; pixel.vy = -pixel.vy; }
            return;
          }
        }

        // B. Supernova r-process neutron capture
        if (isFast && target.temp > 75000 && SUPER_R_PROCESS_TARGETS.has(tElem) && Math.random() < 0.40) {
          const heavy = R_PROCESS_PRODUCTS[Math.floor(Math.random() * R_PROCESS_PRODUCTS.length)];
          safeChange(target, heavy);
          deletePixel(pixel.x, pixel.y);
          return;
        }

        // C. Fertile breeding
        if (tElem === "uranium_238" || tElem === "molten_uranium_238") {
          const dopplerBonus = target.temp > 800 ? 0.08 : 0;
          if (Math.random() < (isFast ? 0.12 : 0.35) + dopplerBonus) {
            safeChange(target, "neptunium_239");
            target.temp += 150;
            deletePixel(pixel.x, pixel.y);
            return;
          }
        } else if (tElem === "thorium_232" || tElem === "molten_thorium_232" || tElem === "thorium") {
          if (Math.random() < (isFast ? 0.10 : 0.38)) {
            safeChange(target, "protactinium_233");
            target.temp += 140;
            deletePixel(pixel.x, pixel.y);
            return;
          }
        }

        // D. Tritium breeding blanket (Li-6 + n -> T + He-4)
        if (tElem === "lithium_6" || tElem === "molten_lithium_6") {
          if (Math.random() < 0.55) {
            safeChange(target, "tritium");
            target.temp += 850;
            safeChange(pixel, "helium");
            return;
          }
        }

        // E. Activation (Co-59 -> Co-60, N-14 -> C-14)
        if (tElem === "cobalt" || tElem === "molten_cobalt") {
          if (Math.random() < 0.30) {
            safeChange(target, "cobalt_60");
            target.temp += 120;
            deletePixel(pixel.x, pixel.y);
            return;
          }
        } else if (tElem === "nitrogen" && !isFast && Math.random() < 0.12) {
          safeChange(target, "carbon_14");
          safeChangeAny(pixel, ["proton", "hydrogen"]);
          return;
        }

        // F. Control rods & Xenon-135 poison
        if (POISONS.has(tElem)) {
          const absorbProb = tElem === "xenon_135" ? 0.96 : 0.85;
          if (!isFast && Math.random() < absorbProb) {
            target.temp += 80;
            if (tElem === "boron" && Math.random() < 0.15) safeChange(target, "lithium_7");
            else if (tElem === "xenon_135") safeChange(target, "xenon_136");
            deletePixel(pixel.x, pixel.y);
            return;
          }
        }

        // G. Moderators
        if (MODERATOR_PROB[tElem] !== undefined) {
          target.temp += isFast ? 35 : 5;
          if (isFast) {
            if (tElem === "water" && Math.random() < 0.05) {
              safeChange(target, "heavy_water");
              deletePixel(pixel.x, pixel.y);
              return;
            }
            if (Math.random() < MODERATOR_PROB[tElem]) {
              safeChange(pixel, "thermal_neutron");
              const d = randomDir();
              pixel.vx = d[0];
              pixel.vy = d[1];
              return;
            } else {
              safeSwap(pixel, target);
              return;
            }
          } else {
            safeSwap(pixel, target);
            return;
          }
        }

        // H. Reflectors & Beryllium (n, 2n)
        if (REFLECTORS.has(tElem)) {
          pixel.vx = -pixel.vx + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0);
          pixel.vy = -pixel.vy + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0);
          pixel.vx = Math.max(-1, Math.min(1, pixel.vx));
          pixel.vy = Math.max(-1, Math.min(1, pixel.vy));
          if (!pixel.vx && !pixel.vy) {
            const d = randomDir();
            pixel.vx = d[0];
            pixel.vy = d[1];
          }
          if (isFast && !pixel.beMultiplied && (tElem === "beryllium" || tElem === "molten_beryllium") && Math.random() < 0.08) {
            pixel.beMultiplied = true;
            spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
          }
          return;
        }

        // I. Shielding
        if (HIGH_Z_SHIELD.has(tElem)) {
          target.temp += 15;
          if (Math.random() < 0.45) {
            deletePixel(pixel.x, pixel.y);
            return;
          } else {
            pixel.vx = -pixel.vx;
            pixel.vy = -pixel.vy;
            return;
          }
        }

        // J. Pass through gases/plasma/fire/radiation
        const tState = elements[tElem]?.state;
        if (tState === "gas" || tElem === "fire" || tElem === "plasma" || RADIOLYSIS_AGENTS.has(tElem)) {
          safeSwap(pixel, target);
        } else {
          const d = randomDir();
          pixel.vx = d[0];
          pixel.vy = d[1];
          return;
        }
      }
    } catch (err) {
      if (!loggedNeutronError) {
        loggedNeutronError = true;
        console.error("[unified_physics_chem] neutronTick error:", err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. INTERACTIVE PHYSICS TOOLS ("tools" CATEGORY)
  // ---------------------------------------------------------------------------

  registerOrEnhance("orbit_launch", {
    color: ["#ffcf40", "#ffe082"],
    category: "tools",
    desc: "Brush over moons, planets, or gas clouds to give exact circular orbital velocity perpendicular to local gravity!",
    tool: function (pixel) {
      if (!pixel || pixel.del || isImmobileElement(pixel.element) || VELOCITY_EXEMPT.has(pixel.element)) return;
      if (!gravFieldActive) rebuildFields();
      if (!gravFieldActive) return;
      const gx = sampleField(macroGx, pixel.x, pixel.y);
      const gy = sampleField(macroGy, pixel.x, pixel.y);
      const gMag = Math.hypot(gx, gy);
      if (gMag < 0.01) return;
      const phi = Math.max(0, sampleField(macroPhi, pixel.x, pixel.y));
      const vCirc = Math.min(MAX_SPEED * 0.92, Math.sqrt(phi * GRAV_ACCEL * FIELD_BLOCK));
      pixel.vx = (-gy / gMag) * vCirc;
      pixel.vy = (gx / gMag) * vCirc;
      movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }
  });

  registerOrEnhance("kinetic_launch", {
    color: ["#ff6e40", "#ff9e80"],
    category: "tools",
    desc: "Kinetic launcher brush: fires brushed matter rapidly right & slightly upward.",
    tool: function (pixel) {
      if (!pixel || pixel.del || isImmobileElement(pixel.element) || VELOCITY_EXEMPT.has(pixel.element)) return;
      pixel.vx = MAX_SPEED * 0.88;
      pixel.vy = -0.35;
      movingPixelsLastTick = Math.max(movingPixelsLastTick, 1);
    }
  });

  registerOrEnhance("vel_stop", {
    color: ["#78909c", "#b0bec5"],
    category: "tools",
    desc: "Inertial damper: cancels all velocity (vx, vy) on brushed pixels immediately.",
    tool: function (pixel) {
      if (!pixel || pixel.del) return;
      pixel.vx = 0; pixel.vy = 0; pixel.rx = 0; pixel.ry = 0;
    }
  });

  registerOrEnhance("compress_tool", {
    color: ["#ab47bc", "#ce93d8"],
    category: "tools",
    desc: "Shock Compressor: applies extreme pressure & adiabatic heat (ignites fusion or presses hot graphite into diamond!).",
    tool: function (pixel) {
      if (!pixel || pixel.del) return;
      pixel.pressure = (pixel.pressure || 0) + 400;
      pixel.temp += 1400;
      if (pixel.element === "graphite" && pixel.temp >= 1500 && elements.diamond) {
        safeChange(pixel, "diamond");
      }
    }
  });

  registerOrEnhance("bond_tool", {
    color: ["#69f0ae", "#b9f6ca"],
    category: "tools",
    desc: "Direct Bond Tool: links adjacent pixels with persistent chemical bonds (keeping both elements intact).",
    tool: function (pixel) {
      if (!pixel || pixel.del || getBondCount(pixel) >= 3) return;
      for (let i = 0; i < adjacentCoords.length; i++) {
        const nx = pixel.x + adjacentCoords[i][0];
        const ny = pixel.y + adjacentCoords[i][1];
        if (!inSafeBounds(nx, ny)) continue;
        const other = pixelMap[nx][ny];
        if (other && !other.del && !hasBondBetween(pixel, other)) {
          if (createBond(pixel, other, "catalyst", 2800)) return;
        }
      }
    }
  });

  registerOrEnhance("cleave_tool", {
    color: ["#ff5252", "#ff8a80"],
    category: "tools",
    desc: "Bond Cleaver Tool: snaps all chemical bonds on brushed pixels.",
    tool: function (pixel) {
      if (!pixel || pixel.del) return;
      breakAllBonds(pixel);
    }
  });

  registerOrEnhance("magnetize_tool", {
    color: ["#e53935", "#1e88e5"],
    category: "tools",
    desc: "Magnetizer Tool: turns iron/steel/neodymium into magnets, or flips North <-> South poles!",
    tool: function (pixel) {
      if (!pixel || pixel.del) return;
      const e = pixel.element;
      if (e === "iron" || e === "steel") safeChange(pixel, "magnet_north");
      else if (e === "iron_filings") safeChange(pixel, "magnet_bead_n");
      else if (e === "neodymium") safeChange(pixel, "neodymium_north");
      else if (e === "magnet_north") safeChange(pixel, "magnet_south");
      else if (e === "magnet_south") safeChange(pixel, "magnet_north");
      else if (e === "neodymium_north") safeChange(pixel, "neodymium_south");
      else if (e === "neodymium_south") safeChange(pixel, "neodymium_north");
      else if (e === "magnet_bead_n") safeChange(pixel, "magnet_bead_s");
      else if (e === "magnet_bead_s") safeChange(pixel, "magnet_bead_n");
    }
  });

  registerOrEnhance("neutron_pulse", {
    color: ["#ff6d00", "#ffd180"],
    category: "tools",
    desc: "Neutron Pulse Trigger: emits fast neutrons around brushed pixels to jump-start fission or breeding.",
    tool: function (pixel) {
      if (!pixel || pixel.del) return;
      if (Math.random() < 0.35) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
    }
  });

  let lastInspectTime = 0;
  registerOrEnhance("inspect_tool", {
    color: ["#26c6da", "#80deea"],
    category: "tools",
    desc: "Physics Telemetry Inspector: click any pixel to print temp, velocity, pressure, g-field, B-field, and active chemical bonds.",
    tool: function (pixel) {
      if (!pixel || pixel.del) return;
      const now = Date.now();
      if (now - lastInspectTime < 250) return;
      lastInspectTime = now;
      const vx = (pixel.vx || 0).toFixed(2);
      const vy = (pixel.vy || 0).toFixed(2);
      const g = gravFieldActive ? Math.hypot(sampleField(macroGx, pixel.x, pixel.y), sampleField(macroGy, pixel.x, pixel.y)).toFixed(2) : "0";
      const b = magFieldActive ? sampleField(macroBmag, pixel.x, pixel.y).toFixed(2) : "0";
      const pBonds = getBonds(pixel);
      const bondList = pBonds && pBonds.length
        ? pBonds.map(x => x.target.element + "(" + x.type + ")").join(", ")
        : "none";
      notifyUser(`${pixel.element} | ${Math.round(pixel.temp)}C | v=(${vx},${vy}) | P=${pixel.pressure || 0} | g=${g} | B=${b} | bonds: ${bondList}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. ASTROPHYSICS, BONDING, MAGNETS & RADIATION ELEMENTS
  // ---------------------------------------------------------------------------

  registerOrEnhance("star_gravity", {
    color: ["#1a0b2e", "#31135e", "#4d1f91"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 99999,
    hardness: 1,
    desc: "Enables global multi-body Gravity-Tile self-gravity (in Element-Based mode). Enables binary stars, orbits, core fusion, and supernovae."
  });

  registerOrEnhance("gravity_well", {
    color: ["#120024", "#2a0052", "#5900a6"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 99999,
    hardness: 1,
    desc: "Localized planetary/stellar gravity anchor. Use orbit_launch on nearby matter to form orbits and rings!"
  });

  registerOrEnhance("neutronium", {
    color: ["#d9f7ff", "#ffffff", "#9ce5ff"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 999999,
    hardness: 1,
    conduct: 1,
    desc: "Degenerate neutron-star core forged by Supernova collapse. Exerts extreme gravity and emits fast neutrons.",
    tick: function (pixel) {
      if (Math.random() < 0.004) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      doDefaults(pixel);
    }
  });

  registerOrEnhance("black_hole_core", {
    color: ["#050008", "#0d0014", "#1a0029"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 9999999,
    hardness: 1,
    desc: "Event-horizon singularity. Devours infalling matter and emits relativistic gamma jets!",
    tick: function (pixel) {
      for (let i = 0; i < adjacentCoords.length; i++) {
        const nx = pixel.x + adjacentCoords[i][0];
        const ny = pixel.y + adjacentCoords[i][1];
        if (!inSafeBounds(nx, ny)) continue;
        const victim = pixelMap[nx][ny];
        if (!victim || victim.del || IMMOBILE_SPECIAL.has(victim.element)) continue;
        breakAllBonds(victim);
        deletePixel(nx, ny);
        if (Math.random() < 0.25) spawnParticle(pixel.x, pixel.y, "gamma_ray", 1);
      }
      doDefaults(pixel);
    }
  });

  registerOrEnhance("field_visualizer", {
    color: ["#00e5ff", "#ffd740"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 1000,
    desc: "Place 1 pixel anywhere to draw live Magnetic (cyan) and Gravity (gold) field vectors on every tile!"
  });

  registerOrEnhance("bond_catalyst", {
    color: ["#6bff7a", "#9cff9e", "#3de050"],
    behavior: behaviors.POWDER,
    category: "chemistry",
    state: "solid",
    density: 10,
    desc: "Drop onto any two adjacent elements to link them with a persistent chemical bond (keeping both pixels intact).",
    tick: function (pixel) {
      const neighbors = [];
      for (let i = 0; i < adjacentCoords.length; i++) {
        const nx = pixel.x + adjacentCoords[i][0];
        const ny = pixel.y + adjacentCoords[i][1];
        if (!inSafeBounds(nx, ny)) continue;
        const n = pixelMap[nx][ny];
        if (n && !n.del && n.element !== "bond_catalyst" && n.element !== "bond_breaker") {
          neighbors.push(n);
        }
      }
      if (neighbors.length >= 2) {
        for (let a = 0; a < neighbors.length; a++) {
          for (let b = a + 1; b < neighbors.length; b++) {
            const p1 = neighbors[a], p2 = neighbors[b];
            const dist = Math.max(Math.abs(p1.x - p2.x), Math.abs(p1.y - p2.y));
            if (dist <= 2 && createBond(p1, p2, "catalyst", 2600)) {
              deletePixel(pixel.x, pixel.y);
              return;
            }
          }
        }
      }
      doDefaults(pixel);
    }
  });

  registerOrEnhance("bond_breaker", {
    color: ["#ff477e", "#ff7096", "#e0245e"],
    behavior: behaviors.GAS,
    category: "chemistry",
    state: "gas",
    density: 0.5,
    desc: "Cleaves all persistent chemical bonds on contact, then dissipates.",
    tick: function (pixel) {
      if (pixel.life === undefined) pixel.life = 25;
      pixel.life--;
      if (pixel.life <= 0) { deletePixel(pixel.x, pixel.y); return; }
      doDefaults(pixel);
    }
  });

  // --- Magnets ---
  registerOrEnhance("magnet_north", {
    color: ["#d92626", "#e83838", "#bf1d1d"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 7500,
    conduct: 0.5,
    hardness: 0.8,
    tempHigh: 770,
    stateHigh: "iron",
    desc: "North magnetic pole (Curie temp: 770 C). Pulls ferromagnetics & South poles; repels North poles; confines hot plasma."
  });

  registerOrEnhance("magnet_south", {
    color: ["#1e5ad9", "#2e6df0", "#1749b5"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 7500,
    conduct: 0.5,
    hardness: 0.8,
    tempHigh: 770,
    stateHigh: "iron",
    desc: "South magnetic pole (Curie temp: 770 C). Pulls ferromagnetics & North poles; repels South poles."
  });

  registerOrEnhance("neodymium_north", {
    color: ["#ff1744", "#ff4569", "#d5002f"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 7500,
    conduct: 0.45,
    hardness: 0.75,
    tempHigh: 310,
    stateHigh: "neodymium",
    desc: "Strong Neodymium North pole (2.2x field, 310 C Curie point)."
  });

  registerOrEnhance("neodymium_south", {
    color: ["#0044ff", "#2962ff", "#0032bd"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 7500,
    conduct: 0.45,
    hardness: 0.75,
    tempHigh: 310,
    stateHigh: "neodymium",
    desc: "Strong Neodymium South pole (2.2x field, 310 C Curie point)."
  });

  registerOrEnhance("electromagnet_north", {
    color: ["#b85d38", "#cc6b43", "#9e4d2d"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 8400,
    conduct: 1,
    hardness: 0.8,
    desc: "Switchable North Electromagnet. Inactive until powered with shock/battery."
  });

  registerOrEnhance("electromagnet_south", {
    color: ["#486b9e", "#587eb5", "#3b5985"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 8400,
    conduct: 1,
    hardness: 0.8,
    desc: "Switchable South Electromagnet. Inactive until powered with shock/battery."
  });

  registerOrEnhance("magnet_bead_n", {
    color: ["#ff5252", "#ff7575"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 7400,
    tempHigh: 770,
    stateHigh: "iron_filings",
    desc: "Movable North-pole magnetic bead."
  });

  registerOrEnhance("magnet_bead_s", {
    color: ["#448aff", "#69a1ff"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 7400,
    tempHigh: 770,
    stateHigh: "iron_filings",
    desc: "Movable South-pole magnetic bead."
  });

  registerOrEnhance("iron_filings", {
    color: ["#525559", "#64686e", "#43464a"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 7870,
    conduct: 0.7,
    tempHigh: 1538,
    stateHigh: "molten_iron",
    desc: "Ferromagnetic iron powder. Pulled along grad|B| toward both poles below 770 C."
  });

  registerOrEnhance("superconductor", {
    color: ["#242933", "#303745", "#1c2029"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 6300,
    conduct: 1,
    hardness: 0.7,
    desc: "YBCO Superconductor. Chill below -180 C for Meissner levitation over any magnet!"
  });

  // --- Radiation & Neutrons ---
  registerOrEnhance("fast_neutron", {
    color: ["#ff4444", "#ff7744", "#ffaa44"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    temp: 20,
    desc: "Fast ~2 MeV neutron. Moderates in water, heavy water, or graphite into thermal neutrons.",
    tick: function (pixel) { neutronTick(pixel, true); }
  });

  registerOrEnhance("thermal_neutron", {
    color: ["#44ccff", "#66eeff", "#99f5ff"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    temp: 20,
    desc: "Moderated slow ~0.025 eV neutron. High fission cross-section; absorbed by control rods.",
    tick: function (pixel) { neutronTick(pixel, false); }
  });

  registerOrEnhance("alpha_particle", {
    color: ["#ffea00", "#ffff72"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    desc: "Alpha particle (He-4 nucleus). Stopped by thin solids; knocks neutrons out of Beryllium.",
    tick: function (pixel) { ionizingParticleTick(pixel, "alpha"); }
  });

  registerOrEnhance("beta_particle", {
    color: ["#00e5ff", "#84ffff"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    desc: "High-energy Beta electron. Stopped by Aluminum, Glass, or metals.",
    tick: function (pixel) { ionizingParticleTick(pixel, "beta"); }
  });

  registerOrEnhance("gamma_ray", {
    color: ["#ea80fc", "#ffffff"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    desc: "High-energy Gamma photon. Breaks chemical bonds; attenuated by Lead, Tungsten, Osmium, U-238, or Concrete.",
    tick: function (pixel) { ionizingParticleTick(pixel, "gamma"); }
  });

  registerOrEnhance("heavy_water", {
    color: ["#1e5ec4", "#246ad6", "#1a52ab"],
    behavior: behaviors.LIQUID,
    category: "nuclear",
    state: "liquid",
    density: 1107,
    tempHigh: 101.4,
    stateHigh: "heavy_steam",
    tempLow: 3.8,
    stateLow: "heavy_ice",
    conduct: 0.02,
    desc: "Deuterium Oxide (D2O). Low-absorption neutron moderator."
  });

  registerOrEnhance("heavy_ice", {
    color: ["#a8d0f5", "#b8daf8"],
    behavior: behaviors.WALL,
    category: "states",
    state: "solid",
    hidden: true,
    density: 1017,
    temp: 0,
    tempHigh: 3.8,
    stateHigh: "heavy_water"
  });

  registerOrEnhance("heavy_steam", {
    color: ["#c7dbf0", "#d7e6f5"],
    behavior: behaviors.GAS,
    category: "states",
    state: "gas",
    hidden: true,
    density: 0.66,
    temp: 110,
    tempLow: 101.4,
    stateLow: "heavy_water",
    tick: function (pixel) {
      if (pixel.temp >= 3200 && Math.random() < 0.20) {
        safeChange(pixel, Math.random() < 0.66 ? "deuterium" : "oxygen");
        return;
      }
      doDefaults(pixel);
    }
  });

  // ---------------------------------------------------------------------------
  // 8. FULL STELLAR & REACTOR FUSION ISOTOPES
  // ---------------------------------------------------------------------------

  defineFullGas({
    id: "deuterium",
    color: ["#6ea8ff", "#88bbff"],
    liquidColor: ["#3c7de0", "#4f8ef0"],
    solidColor: ["#a6cbff", "#c2dcff"],
    category: "isotopes",
    boilTemp: -249.5,
    meltTemp: -254.4,
    density: 0.18,
    desc: "Hydrogen-2. Fuses with Tritium (10,000 C), Deuterium (25,000 C), or Helium-3 (40,000 C).",
    tick: function (pixel) {
      const fr = UPC_CONFIG.fusionRate;
      if (fr > 0) {
        if (pixel.temp >= 10000 && Math.random() < 0.55 * fr) {
          const t = findAdjacentElement(pixel, "tritium");
          if (t) {
            safeChange(pixel, "helium");
            safeChange(t, "fast_neutron");
            pixel.temp += 9000; t.temp += 9000;
            return;
          }
        }
        if (pixel.temp >= 25000 && Math.random() < 0.35 * fr) {
          const other = findAdjacentElement(pixel, "deuterium");
          if (other) {
            if (Math.random() < 0.5) {
              safeChange(pixel, "tritium");
              safeChangeAny(other, ["proton", "hydrogen"]);
            } else {
              safeChange(pixel, "helium_3");
              safeChange(other, "fast_neutron");
            }
            pixel.temp += 4500; other.temp += 4500;
            return;
          }
        }
        if (pixel.temp >= 40000 && Math.random() < 0.45 * fr) {
          const he3 = findAdjacentElement(pixel, "helium_3");
          if (he3) {
            safeChange(pixel, "helium");
            safeChangeAny(he3, ["proton", "hydrogen"]);
            pixel.temp += 11000; he3.temp += 11000;
            return;
          }
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "heavy_steam", elem2: "fire", tempMin: 560, tempMax: 3000, chance: 0.65 }
    }
  });

  defineFullGas({
    id: "tritium",
    color: ["#5cffb0", "#82ffc4"],
    liquidColor: ["#28d483", "#3ee093"],
    solidColor: ["#9effd0", "#c4ffe2"],
    category: "isotopes",
    boilTemp: -248.1,
    meltTemp: -252.5,
    density: 0.27,
    desc: "Radioactive Hydrogen-3. Fuses with Deuterium at 10,000 C; beta-decays into Helium-3.",
    tick: function (pixel) {
      if (Math.random() < 0.00015) {
        safeChange(pixel, "helium_3");
        spawnParticle(pixel.x, pixel.y, "beta_particle", 1);
        pixel.temp += 5;
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullGas({
    id: "helium_3",
    color: ["#ffe0b3", "#ffd18c"],
    liquidColor: ["#f0b86e", "#e6a855"],
    solidColor: ["#fff0d9", "#ffe6bf"],
    category: "isotopes",
    boilTemp: -269.9,
    meltTemp: -272.2,
    density: 0.13,
    desc: "Light Helium-3. Aneutronic fusion with Deuterium (40,000 C) or He-3 + He-3 (45,000 C).",
    tick: function (pixel) {
      if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 45000 && Math.random() < 0.25 * UPC_CONFIG.fusionRate) {
        const other = findAdjacentElement(pixel, "helium_3");
        if (other) {
          safeChange(pixel, "helium");
          safeChangeAny(other, ["proton", "hydrogen"]);
          pixel.temp += 7500; other.temp += 7500;
          return;
        }
      }
      doDefaults(pixel);
    }
  });

  registerOrEnhance("carbon_vapor", {
    color: ["#54545c", "#666670", "#45454d"],
    behavior: behaviors.GAS,
    category: "states",
    state: "gas",
    hidden: true,
    density: 0.52,
    temp: 3700,
    tempLow: 3642,
    stateLow: "graphite",
    desc: "Elemental Carbon-12 gas (>3,642 C). Fuses with Helium (75,000 C -> Oxygen) or Carbon (82,000 C -> Neon/Magnesium).",
    tick: function (pixel) {
      const fr = UPC_CONFIG.fusionRate;
      if (fr > 0) {
        if (pixel.temp >= 75000 && Math.random() < 0.18 * fr) {
          const he = findAdjacentElement(pixel, "helium");
          if (he) {
            safeChange(pixel, "oxygen");
            safeChange(he, "gamma_ray");
            pixel.temp += 5000;
            return;
          }
        }
        if (pixel.temp >= 82000 && Math.random() < 0.15 * fr) {
          const other = findAdjacentElement(pixel, "carbon_vapor");
          if (other) {
            safeChange(pixel, Math.random() < 0.55 ? "neon" : "magnesium_gas");
            safeChange(other, "gamma_ray");
            pixel.temp += 4500;
            return;
          }
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.25 }
    }
  });

  defineFullElement({
    id: "carbon_14",
    color: ["#303835", "#3d4743"],
    moltenColor: ["#7a8f87", "#8ea69d"],
    gasColor: ["#5c6b65", "#6d7d77"],
    category: "isotopes",
    meltTemp: 3550,
    boilTemp: 4027,
    density: 2260,
    conduct: 0.7,
    behavior: behaviors.POWDER,
    desc: "Radioactive Carbon-14 formed by thermal neutrons hitting Nitrogen-14.",
    tick: function (pixel) {
      if (Math.random() < 0.0001) {
        safeChange(pixel, "nitrogen");
        spawnParticle(pixel.x, pixel.y, "beta_particle", 1);
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullGas({
    id: "neon",
    color: ["#ff9678", "#ffab91"],
    liquidColor: ["#ff7043", "#ff8a65"],
    solidColor: ["#ffccbc", "#ffd8cc"],
    category: "gases",
    boilTemp: -246.1,
    meltTemp: -248.6,
    density: 0.90,
    conduct: 0.4,
    desc: "Noble gas forged by Carbon burning. Fuses with Helium at 88,000 C into Magnesium.",
    tick: function (pixel) {
      if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 88000 && Math.random() < 0.16 * UPC_CONFIG.fusionRate) {
        const he = findAdjacentElement(pixel, "helium");
        if (he) {
          safeChange(pixel, "magnesium_gas");
          safeChange(he, "gamma_ray");
          pixel.temp += 4200;
          return;
        }
      }
      doDefaults(pixel);
    }
  });

  defineFullGas({
    id: "argon",
    color: ["#c7b8ff", "#d6ccff"],
    liquidColor: ["#9b87f5", "#ac99ff"],
    solidColor: ["#e6e0ff", "#f0ecff"],
    category: "gases",
    boilTemp: -185.8,
    meltTemp: -189.3,
    density: 1.78,
    desc: "Dense inert noble shielding gas. Sinks in air to protect Cesium or White Phosphorus from oxygen."
  });

  defineFullElement({
    id: "magnesium",
    color: ["#d4d9de", "#e2e6eb", "#c5cbd1"],
    moltenColor: ["#f0e8d5", "#fff8e8"],
    gasColor: ["#e8ecf0", "#f5f7fa"],
    category: "metals",
    meltTemp: 650,
    boilTemp: 1091,
    density: 1738,
    conduct: 0.78,
    hardness: 0.5,
    tickAllStates: true,
    desc: "Reactive light metal. Burns hot in oxygen (>470 C), reacts with steam, and fuses with Helium at 92,000 C into Silicon!",
    tick: function (pixel) {
      if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 92000 && Math.random() < 0.16 * UPC_CONFIG.fusionRate) {
        const he = findAdjacentElement(pixel, "helium");
        if (he) {
          safeChange(pixel, "silicon_gas");
          safeChange(he, "gamma_ray");
          pixel.temp += 4000;
          return;
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "ash", elem2: "fire", tempMin: 470, tempMax: 3200, chance: 0.45, func: function (p1) { p1.temp += 1800; } },
      steam:  { elem1: "ash", elem2: "hydrogen", tempMin: 300, chance: 0.35, func: function (p1) { p1.temp += 900; } }
    }
  });

  const SILICON_STATES = new Set(["silicon", "molten_silicon", "silicon_gas"]);
  defineFullElement({
    id: "silicon",
    color: ["#4b525c", "#58606b", "#3f464f"],
    moltenColor: ["#e8a86b", "#f2b97e"],
    gasColor: ["#8a96a6", "#9ca8b8"],
    category: "solids",
    meltTemp: 1414,
    boilTemp: 3265,
    density: 2329,
    conduct: 0.35,
    hardness: 0.82,
    tickAllStates: true,
    desc: "Crystalline semiconductor (Si-28). Forged by Oxygen fusion (95,000 C), Mg+He fusion (92,000 C), or smelting sand + graphite (>1,900 C). Fuses past 115,000 C into Nickel-56 -> Iron!",
    tick: function (pixel) {
      if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 115000 && Math.random() < 0.16 * UPC_CONFIG.fusionRate) {
        const partner = findAdjacentElement(pixel, "helium") || findAdjacentElement(pixel, SILICON_STATES);
        if (partner) {
          safeChange(pixel, "nickel_56_gas");
          safeChange(partner, "gamma_ray");
          pixel.temp += 3000;
          return;
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "sand", elem2: "fire", tempMin: 900, tempMax: 2500, chance: 0.15 }
    }
  });

  defineFullElement({
    id: "nickel_56",
    color: ["#9cb5a8", "#adc7b9"],
    moltenColor: ["#ffbe76", "#ffd39b"],
    gasColor: ["#c7e3d4", "#daf2e5"],
    category: "isotopes",
    meltTemp: 1455,
    boilTemp: 2913,
    density: 8908,
    conduct: 0.7,
    tickAllStates: true,
    desc: "Radioactive Nickel-56 forged by Silicon burning. Decays into Cobalt-56 -> Iron-56.",
    tick: function (pixel) {
      pixel.temp += 0.35;
      if (Math.random() < 0.008) {
        const targetState = pixel.element === "nickel_56_gas" ? "cobalt_56_gas"
          : (pixel.element === "molten_nickel_56" ? "molten_cobalt_56" : "cobalt_56");
        safeChange(pixel, targetState);
        pixel.temp += 180;
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "cobalt_56",
    color: ["#7295c4", "#86a8d6"],
    moltenColor: ["#ffa366", "#ffb885"],
    gasColor: ["#a4bfe3", "#b8cff0"],
    category: "isotopes",
    meltTemp: 1495,
    boilTemp: 2927,
    density: 8900,
    conduct: 0.7,
    tickAllStates: true,
    desc: "Supernova decay isotope (from Nickel-56). Decays into stable Iron-56.",
    tick: function (pixel) {
      pixel.temp += 0.25;
      if (Math.random() < 0.006) {
        if (pixel.temp >= 2862) safeChangeAny(pixel, ["iron_gas", "molten_iron", "iron"]);
        else if (pixel.temp >= 1538) safeChangeAny(pixel, ["molten_iron", "iron"]);
        else safeChange(pixel, "iron");
        pixel.temp += 120;
        return;
      }
      doDefaults(pixel);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. FISSILE, FERTILE, BREEDER & DECAY-CHAIN ISOTOPES
  // ---------------------------------------------------------------------------

  defineFullElement({
    id: "uranium_235",
    color: ["#4b7843", "#578c4e", "#3f6938"],
    moltenColor: ["#9be05a", "#b7f06e"],
    gasColor: ["#88b878", "#a2cc95"],
    category: "nuclear",
    meltTemp: 1132,
    boilTemp: 4131,
    density: 18950,
    conduct: 0.45,
    desc: "Fissile Uranium-235. Captures thermal neutrons -> ~200 MeV heat, 2-3 fast neutrons, and fission products.",
    tick: function (pixel) {
      if (Math.random() < 0.00025) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "uranium_238",
    color: ["#3b4d3b", "#455945", "#324232"],
    moltenColor: ["#7a9c59", "#8eb06a"],
    gasColor: ["#6b7d6b", "#7c8f7c"],
    category: "nuclear",
    meltTemp: 1132,
    boilTemp: 4131,
    density: 19100,
    conduct: 0.45,
    desc: "Fertile Depleted Uranium (U-238). Dense gamma shield; breeds Neptunium-239 -> Plutonium-239."
  });

  defineFullElement({
    id: "neptunium_239",
    color: ["#5e6e7d", "#6e8091"],
    moltenColor: ["#b58d52", "#cfa363"],
    gasColor: ["#8e9eab", "#a3b3c2"],
    category: "isotopes",
    meltTemp: 644,
    boilTemp: 3902,
    density: 20450,
    conduct: 0.35,
    desc: "Breeder intermediate (U-238 + n). Beta-decays into Plutonium-239.",
    tick: function (pixel) {
      pixel.temp += 0.08;
      if (Math.random() < 0.003) {
        safeChange(pixel, "plutonium_239");
        spawnParticle(pixel.x, pixel.y, "beta_particle", 1);
        pixel.temp += 60;
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "plutonium_239",
    color: ["#6b756b", "#7d8a7d", "#5c665c"],
    moltenColor: ["#e68a45", "#f5a056"],
    gasColor: ["#9ca89c", "#b0bdb0"],
    category: "nuclear",
    meltTemp: 640,
    boilTemp: 3228,
    density: 19816,
    conduct: 0.25,
    desc: "Fissile Plutonium-239. High fast-neutron cross-section; self-heats via alpha decay.",
    tick: function (pixel) {
      pixel.temp += 0.05;
      if (Math.random() < 0.0006) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "thorium_232",
    color: ["#63605c", "#75726d", "#575450"],
    moltenColor: ["#d98a4e", "#eb9e60"],
    gasColor: ["#8f8b85", "#a39f98"],
    category: "nuclear",
    meltTemp: 1750,
    boilTemp: 4788,
    density: 11724,
    conduct: 0.5,
    desc: "Fertile Thorium-232. Captures neutrons -> Protactinium-233 -> fissile Uranium-233."
  });

  defineFullElement({
    id: "protactinium_233",
    color: ["#7a7380", "#8c8494"],
    moltenColor: ["#c78b63", "#db9e74"],
    gasColor: ["#a199a8", "#b3abc0"],
    category: "isotopes",
    meltTemp: 1568,
    boilTemp: 4027,
    density: 15370,
    conduct: 0.4,
    desc: "Thorium breeder intermediate. Beta-decays into fissile Uranium-233.",
    tick: function (pixel) {
      pixel.temp += 0.06;
      if (Math.random() < 0.002) {
        safeChange(pixel, "uranium_233");
        spawnParticle(pixel.x, pixel.y, "beta_particle", 1);
        pixel.temp += 50;
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "uranium_233",
    color: ["#4d8066", "#5a9476", "#427058"],
    moltenColor: ["#8be0a4", "#a3f0ba"],
    gasColor: ["#84b89c", "#9accb1"],
    category: "nuclear",
    meltTemp: 1132,
    boilTemp: 4131,
    density: 18900,
    conduct: 0.45,
    desc: "Fissile Uranium-233 bred from Thorium-232."
  });

  defineFullElement({
    id: "californium_252",
    color: ["#a8b099", "#bcc4ab"],
    moltenColor: ["#ffad66", "#ffc285"],
    gasColor: ["#d4dbc5", "#e4ebd5"],
    category: "nuclear",
    meltTemp: 900,
    boilTemp: 1470,
    density: 15100,
    conduct: 0.4,
    desc: "Spontaneous-fission neutron source! Continuously emits fast neutrons.",
    tick: function (pixel) {
      pixel.temp += 0.35;
      if (Math.random() < 0.03) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "americium_241",
    color: ["#c2c7cc", "#d3d8de"],
    moltenColor: ["#f0b07a", "#ffc48f"],
    gasColor: ["#dee3e8", "#eef2f7"],
    category: "isotopes",
    meltTemp: 1176,
    boilTemp: 2607,
    density: 13670,
    conduct: 0.45,
    desc: "Steady alpha emitter (pair with Beryllium for an Am-Be neutron gun).",
    tick: function (pixel) {
      pixel.temp += 0.12;
      if (Math.random() < 0.015) spawnParticle(pixel.x, pixel.y, "alpha_particle", 1);
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "radium_226",
    color: ["#80ff95", "#a3ffb3", "#64e87b"],
    moltenColor: ["#b8ffc4", "#d4ffdc"],
    gasColor: ["#a8e6b2", "#c2f2ca"],
    category: "isotopes",
    meltTemp: 700,
    boilTemp: 1737,
    density: 5500,
    conduct: 0.5,
    desc: "Radioluminescent metal. Alpha-decays into Radon -> Polonium-210 -> Lead.",
    tick: function (pixel) {
      pixel.temp += 0.12;
      if (Math.random() < 0.008) spawnParticle(pixel.x, pixel.y, "alpha_particle", 1);
      if (Math.random() < 0.0004) { safeChange(pixel, "radon"); return; }
      doDefaults(pixel);
    }
  });

  defineFullGas({
    id: "radon",
    color: ["#b8e0c8", "#ccebd8"],
    liquidColor: ["#8ac2a0", "#9cd4b2"],
    solidColor: ["#ffaa55", "#ff8844"],
    category: "isotopes",
    boilTemp: -61.7,
    meltTemp: -71.0,
    density: 9.73,
    desc: "Dense radioactive noble gas. Sinks in air, glows orange when frozen, decays to Polonium-210.",
    tick: function (pixel) {
      if (Math.random() < 0.0005) {
        safeChange(pixel, "polonium_210");
        spawnParticle(pixel.x, pixel.y, "alpha_particle", 1);
        pixel.temp += 20;
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "polonium_210",
    color: ["#8c9e99", "#9eb0ab"],
    moltenColor: ["#b5f5d8", "#ccffe8"],
    gasColor: ["#a8bfb9", "#bcd4ce"],
    category: "isotopes",
    meltTemp: 254,
    boilTemp: 962,
    density: 9196,
    conduct: 0.5,
    desc: "Intense alpha emitter (~140 W/g). Pair with Beryllium for a Po-Be neutron initiator; decays to Lead.",
    tick: function (pixel) {
      pixel.temp += 0.45;
      if (Math.random() < 0.02) spawnParticle(pixel.x, pixel.y, "alpha_particle", 1);
      if (Math.random() < 0.00025 && elements.lead) { safeChange(pixel, "lead"); return; }
      doDefaults(pixel);
    }
  });

  defineFullGas({
    id: "xenon_135",
    color: ["#9a78e3", "#b091f2"],
    liquidColor: ["#6c47bd", "#7d55d1"],
    solidColor: ["#c6b3f5", "#d8c9fa"],
    category: "isotopes",
    boilTemp: -108.1,
    meltTemp: -111.8,
    density: 5.89,
    desc: "Reactor poison with huge thermal neutron capture cross-section. Burns to Xe-136 or decays to Cs-135.",
    tick: function (pixel) {
      if (Math.random() < 0.0012) {
        safeChange(pixel, "cesium_135");
        spawnParticle(pixel.x, pixel.y, "beta_particle", 1);
        return;
      }
      doDefaults(pixel);
    }
  });

  defineFullGas({
    id: "xenon_136",
    color: ["#7c6fa8", "#9183bd"],
    liquidColor: ["#5a4d82", "#695a94"],
    solidColor: ["#b5abdb", "#c8c0e6"],
    category: "isotopes",
    boilTemp: -108.1,
    meltTemp: -111.8,
    density: 5.93,
    desc: "Stable Xenon-136 burnout product."
  });

  defineFullGas({
    id: "krypton_92",
    color: ["#b8d4e8", "#cfe5f5"],
    liquidColor: ["#80a8c7", "#92bad9"],
    solidColor: ["#dcebf7", "#ebf4fc"],
    category: "isotopes",
    boilTemp: -153.4,
    meltTemp: -157.4,
    density: 3.75,
    desc: "Fission gas that emits delayed thermal neutrons before decaying to Strontium-90.",
    tick: function (pixel) {
      pixel.temp += 0.15;
      if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.0015) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "thermal_neutron");
      }
      if (Math.random() < 0.004) { safeChange(pixel, "strontium_90"); return; }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "barium_141",
    color: ["#a3a89c", "#b5baa9"],
    moltenColor: ["#d9b977", "#ebca86"],
    gasColor: ["#cfd4c7", "#dfe3d8"],
    category: "isotopes",
    meltTemp: 727,
    boilTemp: 1897,
    density: 3510,
    conduct: 0.4,
    behavior: behaviors.POWDER,
    desc: "Fission daughter with decay heat and delayed neutron emission.",
    tick: function (pixel) {
      pixel.temp += 0.12;
      if (UPC_CONFIG.delayedNeutrons && Math.random() < 0.0008) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "thermal_neutron");
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "strontium_90",
    color: ["#c2c7b8", "#d3d9c7"],
    moltenColor: ["#e6c373", "#f2d183"],
    gasColor: ["#e0e3d8", "#edf0e6"],
    category: "isotopes",
    meltTemp: 777,
    boilTemp: 1382,
    density: 2640,
    conduct: 0.45,
    behavior: behaviors.POWDER,
    desc: "Long-lived fission daughter (RTG beta heat source).",
    tick: function (pixel) {
      pixel.temp += 0.08;
      if (Math.random() < 0.004) spawnParticle(pixel.x, pixel.y, "beta_particle", 1);
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "cesium_135",
    color: ["#d9c27e", "#e6cf8c"],
    moltenColor: ["#f0d88b", "#fce597"],
    gasColor: ["#ebdcb0", "#f5e8c1"],
    category: "isotopes",
    meltTemp: 28.5,
    boilTemp: 671,
    density: 1930,
    conduct: 0.65,
    behavior: behaviors.POWDER,
    desc: "Long-lived Cesium-135 from Xenon-135 decay."
  });

  // ---------------------------------------------------------------------------
  // 10. REACTOR, MAGNETIC & EXOTIC CHEMICAL ELEMENTS
  // ---------------------------------------------------------------------------

  registerOrEnhance("graphite", {
    _override: true,
    color: ["#2b2b2e", "#36363a", "#232326"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "solid",
    density: 2260,
    conduct: 0.85,
    hardness: 0.65,
    tempHigh: 3642,
    stateHigh: "carbon_vapor",
    desc: "Crystalline carbon moderator. Sublimates to carbon_vapor (>3,642 C); smelts sand -> silicon (>1,900 C) & rust -> iron (>1,100 C); compresses into diamond!",
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.15 },
      sand:   { elem1: "carbon_dioxide", elem2: "molten_silicon", tempMin: 1900, tempMax: 3500, chance: 0.22 },
      rust:   { elem1: "carbon_dioxide", elem2: "molten_iron", tempMin: 1100, tempMax: 3200, chance: 0.25 }
    }
  });

  defineFullElement({
    id: "beryllium",
    color: ["#8c9c94", "#9eb0a7", "#7d8c85"],
    moltenColor: ["#d99b66", "#eba971"],
    gasColor: ["#b5c4bc", "#c8d6cf"],
    category: "nuclear",
    meltTemp: 1287,
    boilTemp: 2470,
    density: 1850,
    conduct: 0.75,
    hardness: 0.8,
    desc: "Neutron reflector & (n, 2n) multiplier. Pair with Polonium-210 or Americium-241 for an alpha-beryllium neutron gun.",
    reactions: {
      polonium_210:  { chance: 0.08, func: function (p1) { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 15; } },
      americium_241: { chance: 0.05, func: function (p1) { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 10; } }
    }
  });

  defineFullElement({
    id: "boron",
    color: ["#3a3330", "#4a413d", "#2e2826"],
    moltenColor: ["#b85e37", "#cc6b41"],
    gasColor: ["#786c67", "#8a7c76"],
    category: "nuclear",
    meltTemp: 2076,
    boilTemp: 3927,
    density: 2340,
    conduct: 0.15,
    hardness: 0.92,
    tickAllStates: true,
    desc: "Control-rod neutron absorber. Also fuels aneutronic p-B11 fusion with Hydrogen above 55,000 C -> Helium!",
    tick: function (pixel) {
      if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 55000 && Math.random() < 0.20 * UPC_CONFIG.fusionRate) {
        const h = findAdjacentElement(pixel, "hydrogen");
        if (h) {
          safeChange(pixel, "helium");
          safeChange(h, "helium");
          pixel.temp += 9500; h.temp += 9500;
          return;
        }
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "cadmium",
    color: ["#9da8b8", "#adb8c9", "#8c96a6"],
    moltenColor: ["#cfd6e0", "#dfe6f0"],
    gasColor: ["#b8c2d1", "#cbd4e3"],
    category: "nuclear",
    meltTemp: 321,
    boilTemp: 767,
    density: 8650,
    conduct: 0.7,
    hardness: 0.45,
    desc: "Control-rod metal with massive thermal neutron cross-section."
  });

  defineFullElement({
    id: "hafnium",
    color: ["#7a8491", "#8b95a3", "#697380"],
    moltenColor: ["#eb9952", "#ffa963"],
    gasColor: ["#a3adb8", "#b6c0cc"],
    category: "nuclear",
    meltTemp: 2233,
    boilTemp: 4603,
    density: 13310,
    conduct: 0.55,
    hardness: 0.88,
    desc: "Refractory submarine-reactor control rod absorber."
  });

  defineFullElement({
    id: "tungsten",
    color: ["#5b616b", "#6b727d", "#4d525c"],
    moltenColor: ["#fff3b0", "#fff9d4"],
    gasColor: ["#a8b0bd", "#bcc4d1"],
    category: "metals",
    meltTemp: 3422,
    boilTemp: 5555,
    density: 19250,
    conduct: 0.78,
    hardness: 0.96,
    desc: "Highest melting point of all pure metals (3,422 C). Ideal tokamak armor, neutron reflector, and gamma shield."
  });

  defineFullElement({
    id: "lithium_6",
    color: ["#b8bcc2", "#c7cbd1"],
    moltenColor: ["#e0c59b", "#f0d4a8"],
    gasColor: ["#d6dae0", "#e6e9f0"],
    category: "isotopes",
    meltTemp: 180.5,
    boilTemp: 1342,
    density: 460,
    conduct: 0.6,
    hardness: 0.25,
    desc: "Fusion blanket breeder: captures neutrons -> Tritium + Helium-4.",
    reactions: {
      water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: function (p1) { p1.temp += 300; } }
    }
  });

  defineFullElement({
    id: "lithium_7",
    color: ["#aeb3ba", "#bfc4cc"],
    moltenColor: ["#d9be93", "#e8cca0"],
    gasColor: ["#cfd4db", "#dfe4eb"],
    category: "isotopes",
    meltTemp: 180.5,
    boilTemp: 1342,
    density: 534,
    conduct: 0.6,
    hardness: 0.25,
    desc: "Low-absorption Lithium-7 isotope.",
    reactions: {
      water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: function (p1) { p1.temp += 300; } }
    }
  });

  defineFullElement({
    id: "nickel",
    color: ["#a8a89e", "#babab0", "#96968c"],
    moltenColor: ["#eb9a52", "#ffa961"],
    gasColor: ["#c7c7bd", "#d9d9cf"],
    category: "metals",
    meltTemp: 1455,
    boilTemp: 2913,
    density: 8908,
    conduct: 0.72,
    hardness: 0.75,
    behavior: behaviors.POWDER,
    desc: "Ferromagnetic metal (Curie temp: 358 C)."
  });

  defineFullElement({
    id: "cobalt",
    color: ["#587196", "#6682ab", "#4c6282"],
    moltenColor: ["#e6863e", "#f59851"],
    gasColor: ["#8da2c2", "#9fb4d4"],
    category: "metals",
    meltTemp: 1495,
    boilTemp: 2927,
    density: 8900,
    conduct: 0.72,
    hardness: 0.78,
    behavior: behaviors.POWDER,
    desc: "Ferromagnetic metal (highest Curie temp: 1,115 C). Neutron activation breeds Cobalt-60."
  });

  defineFullElement({
    id: "cobalt_60",
    color: ["#3b6eff", "#5985ff", "#2c5be6"],
    moltenColor: ["#7aa2ff", "#99b8ff"],
    gasColor: ["#6b93ff", "#88a8ff"],
    category: "isotopes",
    meltTemp: 1495,
    boilTemp: 2927,
    density: 8900,
    conduct: 0.72,
    hardness: 0.78,
    desc: "Neutron-activated Cobalt-60. Intense gamma-ray emitter.",
    tick: function (pixel) {
      pixel.temp += 0.25;
      if (Math.random() < 0.015) spawnParticle(pixel.x, pixel.y, "gamma_ray", 1);
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "neodymium",
    color: ["#8c929c", "#9da4b0"],
    moltenColor: ["#eb9b5e", "#ffa96e"],
    gasColor: ["#b4bac4", "#c5cbd6"],
    category: "metals",
    meltTemp: 1024,
    boilTemp: 3074,
    density: 7010,
    conduct: 0.5,
    hardness: 0.65,
    behavior: behaviors.POWDER,
    desc: "Rare-earth magnetic metal (Curie temp: 310 C)."
  });

  defineFullElement({
    id: "gadolinium",
    color: ["#a3b4bd", "#b5c6cf"],
    moltenColor: ["#e6aa6e", "#f5bb7f"],
    gasColor: ["#c7d6de", "#d9e6ed"],
    category: "metals",
    meltTemp: 1313,
    boilTemp: 3273,
    density: 7900,
    conduct: 0.45,
    hardness: 0.6,
    behavior: behaviors.POWDER,
    desc: "Magnetic thermal switch: ferromagnetic below 20 C, non-magnetic above 20 C."
  });

  defineFullElement({
    id: "bismuth",
    color: ["#c7a4d6", "#9be3d8", "#f0c88c"],
    moltenColor: ["#d9d4e3", "#ebe6f5"],
    gasColor: ["#e0d5eb", "#efe6fa"],
    category: "metals",
    meltTemp: 271.4,
    boilTemp: 1564,
    density: 9780,
    conduct: 0.25,
    hardness: 0.4,
    behavior: behaviors.POWDER,
    desc: "Strongest room-temp diamagnet — weakly repelled by both North and South poles."
  });

  defineFullElement({
    id: "platinum",
    color: ["#d6dce3", "#e5ebf2", "#c4cbd4"],
    moltenColor: ["#ffe1b8", "#ffedd4"],
    gasColor: ["#e6ecf2", "#f2f7fc"],
    category: "metals",
    meltTemp: 1768,
    boilTemp: 3825,
    density: 21450,
    conduct: 0.85,
    hardness: 0.8,
    desc: "Precious catalyst: ignites H2+O2 at room temp and synthesizes Ammonia (N2+H2) at 350-650 C.",
    tick: function (pixel) {
      if (Math.random() < 0.25) {
        const h = findAdjacentElement(pixel, "hydrogen");
        if (h) {
          const o = findAdjacentElement(pixel, "oxygen");
          if (o) {
            safeChange(h, "steam");
            safeChange(o, "fire");
            pixel.temp += 120;
            return;
          }
          if (pixel.temp >= 350 && pixel.temp <= 650 && elements.ammonia) {
            const n = findAdjacentElement(pixel, "nitrogen");
            if (n) {
              safeChange(h, "ammonia");
              safeChange(n, "ammonia");
              pixel.temp += 60;
              return;
            }
          }
        }
      }
      doDefaults(pixel);
    }
  });

  defineFullElement({
    id: "cesium",
    color: ["#e3cf86", "#edda95", "#d4bf77"],
    moltenColor: ["#f5e29d", "#ffedab"],
    gasColor: ["#f2e6bd", "#fcf1cc"],
    category: "metals",
    meltTemp: 28.5,
    boilTemp: 671,
    density: 1930,
    conduct: 0.72,
    hardness: 0.1,
    behavior: behaviors.POWDER,
    desc: "Melts at 28.5 C; detonates violently on contact with water or ice.",
    reactions: {
      water:  { chance: 0.9, func: function (p1) { safeChange(p1, "hydrogen"); p1.temp += 1200; explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } },
      ice:    { chance: 0.7, func: function (p1) { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } },
      oxygen: { elem1: "fire", elem2: "ash", tempMin: 35, chance: 0.35 }
    }
  });

  defineFullElement({
    id: "rubidium",
    color: ["#c9cfd6", "#d8dee6"],
    moltenColor: ["#dfe5ed", "#edf2f7"],
    gasColor: ["#cfd6de", "#dee4eb"],
    category: "metals",
    meltTemp: 39.3,
    boilTemp: 688,
    density: 1532,
    conduct: 0.7,
    hardness: 0.12,
    behavior: behaviors.POWDER,
    desc: "Soft alkali metal (melts at 39.3 C). Explodes on contact with water.",
    reactions: {
      water: { chance: 0.85, func: function (p1) { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 3, "fire,hydrogen,steam"); } }
    }
  });

  defineFullElement({
    id: "gallium",
    color: ["#b4c2d1", "#c5d2e0", "#a4b2c2"],
    moltenColor: ["#d4e0ed", "#e3edf7"],
    gasColor: ["#c7d4e3", "#d8e4f2"],
    category: "metals",
    meltTemp: 29.8,
    boilTemp: 2400,
    density: 5910,
    conduct: 0.65,
    hardness: 0.35,
    desc: "Melts in your hand (29.8 C). Embrittles solid aluminum into scrap.",
    reactions: {
      aluminum: { elem2: "metal_scrap", chance: 0.25 }
    }
  });

  defineFullElement({
    id: "phosphorus_white",
    color: ["#f5f0c4", "#fffad1", "#e8e2b0"],
    moltenColor: ["#fff49e", "#fff9ba"],
    gasColor: ["#f0ebb9", "#faf5c8"],
    category: "chemistry",
    meltTemp: 44.1,
    boilTemp: 280.5,
    density: 1823,
    conduct: 0.05,
    hardness: 0.2,
    behavior: behaviors.POWDER,
    desc: "Pyrophoric White Phosphorus. Auto-ignites in oxygen (>30 C); heat >250 C without oxygen to form Red Phosphorus.",
    tick: function (pixel) {
      if (pixel.temp >= 250 && pixel.temp < 400 && Math.random() < 0.04) {
        if (!findAdjacentElement(pixel, "oxygen")) { safeChange(pixel, "phosphorus_red"); return; }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "fire", elem2: "smoke", tempMin: 30, chance: 0.5, func: function (p1) { p1.temp += 800; } }
    }
  });

  defineFullElement({
    id: "phosphorus_red",
    color: ["#9e2b25", "#b5352e", "#87221d"],
    moltenColor: ["#d94a38", "#eb5a46"],
    gasColor: ["#f0ebb9", "#faf5c8"],
    category: "chemistry",
    meltTemp: 590,
    boilTemp: 620,
    density: 2340,
    conduct: 0.05,
    hardness: 0.35,
    behavior: behaviors.POWDER,
    desc: "Stable polymeric Red Phosphorus. Ignites in oxygen above 260 C.",
    reactions: {
      oxygen: { elem1: "fire", elem2: "smoke", tempMin: 260, chance: 0.35, func: function (p1) { p1.temp += 700; } }
    }
  });

  defineFullElement({
    id: "alumina",
    color: ["#e8ecf0", "#f2f5f7", "#d8dde3"],
    moltenColor: ["#ffcf9e", "#ffe0bd"],
    gasColor: ["#e6eaed", "#f5f8fa"],
    category: "chemistry",
    meltTemp: 2072,
    boilTemp: 2977,
    density: 3950,
    conduct: 0.1,
    hardness: 0.9,
    behavior: behaviors.POWDER,
    desc: "Aluminum Oxide (Al2O3) ceramic slag produced by Thermite (rust + aluminum > 1,200 C)."
  });

  defineFullElement({
    id: "osmium",
    color: ["#526075", "#5f6e85", "#465366"],
    moltenColor: ["#e69653", "#f5a764"],
    gasColor: ["#7c8ba3", "#8d9cb5"],
    category: "metals",
    meltTemp: 3033,
    boilTemp: 5012,
    density: 22590,
    conduct: 0.7,
    hardness: 0.95,
    desc: "Densest natural element on Earth (22,590 kg/m^3). Exceptional gamma shield."
  });

  // ---------------------------------------------------------------------------
  // 11. BUILT-IN DARK-MODE IN-GAME SETTINGS PANEL + BETTERSETTINGS SYNC
  // ---------------------------------------------------------------------------

  const uiControls = {};
  let statsEl = null;
  let panelEl = null;

  function syncSettingsUI() {
    for (const key of Object.keys(uiControls)) {
      const ctrl = uiControls[key];
      if (!ctrl) continue;
      if (ctrl.type === "checkbox") {
        ctrl.checked = !!UPC_CONFIG[key];
      } else {
        ctrl.value = String(UPC_CONFIG[key]);
      }
      if (ctrl._valLabel) {
        ctrl._valLabel.textContent = String(UPC_CONFIG[key]);
      }
    }
  }

  function applyPreset(name) {
    if (name === "default") {
      Object.assign(UPC_CONFIG, DEFAULT_CONFIG);
    } else if (name === "stellar") {
      Object.assign(UPC_CONFIG, {
        gravityMethod: "star",
        fieldTileSize: 4,
        fieldRebuildInterval: 2,
        gravAccel: 0.042,
        starDrag: 0.998,
        fusionRate: 1.5,
        supernovaEnabled: true,
        autoBonding: false
      });
    } else if (name === "reactor") {
      Object.assign(UPC_CONFIG, {
        gravityMethod: "element",
        fieldTileSize: 4,
        fieldRebuildInterval: 2,
        fissionHeatScale: 1.0,
        maxNeutrons: 480,
        delayedNeutrons: true,
        plasmaConfinement: true,
        autoBonding: true
      });
    } else if (name === "fast") {
      Object.assign(UPC_CONFIG, {
        gravityMethod: "com",
        fieldTileSize: 6,
        fieldRebuildInterval: 4,
        maxNeutrons: 200,
        maxBonds: 300,
        showFields: false
      });
    }
    applyUPCConfig(true);
    notifyUser("Unified Physics preset applied: " + name);
  }

  function createSettingsUI() {
    if (typeof document === "undefined" || document.getElementById("upc-settings-btn")) return;

    const style = document.createElement("style");
    style.id = "upc-settings-style";
    style.textContent = `
      #upc-settings-btn {
        position: fixed; top: 10px; right: 12px; z-index: 99998;
        background: #181a22; color: #e6ecff; border: 1px solid #3c4663;
        border-radius: 6px; padding: 6px 11px; font: 600 12px/1 system-ui, sans-serif;
        cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.45);
      }
      #upc-settings-btn:hover { background: #232838; border-color: #66b2ff; }
      #upc-settings-panel {
        position: fixed; top: 44px; right: 12px; z-index: 99999;
        width: 325px; max-height: calc(100vh - 64px); overflow-y: auto;
        background: rgba(18, 20, 27, 0.96); color: #e2e8f5;
        border: 1px solid #343d54; border-radius: 9px; padding: 12px 14px;
        font: 12px/1.4 system-ui, -apple-system, sans-serif;
        box-shadow: 0 10px 28px rgba(0,0,0,0.65); display: none;
      }
      #upc-settings-panel h3 {
        margin: 0 0 8px 0; font-size: 14px; color: #7cc4ff;
        display: flex; justify-content: space-between; align-items: center;
      }
      #upc-settings-panel .upc-sec {
        margin: 10px 0 5px 0; padding-top: 7px; border-top: 1px solid #2b3245;
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8c9bbd;
      }
      #upc-settings-panel .upc-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin: 5px 0;
      }
      #upc-settings-panel label { flex: 1; color: #d5ddf0; }
      #upc-settings-panel select, #upc-settings-panel input[type="range"] {
        width: 140px; background: #101218; color: #eef3ff;
        border: 1px solid #39435e; border-radius: 4px; padding: 2px 4px; font-size: 11.5px;
      }
      #upc-settings-panel .upc-val {
        width: 38px; text-align: right; color: #8cd1ff; font-variant-numeric: tabular-nums;
      }
      #upc-settings-panel .upc-presets {
        display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 6px 0 8px 0;
      }
      #upc-settings-panel button.upc-act {
        background: #23293a; color: #dce6ff; border: 1px solid #3a4563;
        border-radius: 5px; padding: 5px 7px; font-size: 11px; cursor: pointer;
      }
      #upc-settings-panel button.upc-act:hover { background: #2e3852; border-color: #7cc4ff; }
      #upc-stats-bar {
        background: #11131a; border: 1px solid #272e40; border-radius: 5px;
        padding: 6px 8px; font: 11px/1.45 ui-monospace, Consolas, monospace; color: #9ad1b8;
        margin-bottom: 6px;
      }
    `;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "upc-settings-btn";
    btn.textContent = "Physics Settings";
    btn.title = "Open Unified Physics & Chemistry Settings (Shift+P)";
    document.body.appendChild(btn);

    panelEl = document.createElement("div");
    panelEl.id = "upc-settings-panel";

    // Prevent clicks/keys inside panel from painting on canvas or triggering game hotkeys
    ["mousedown", "mouseup", "click", "wheel", "keydown", "keyup", "touchstart"].forEach(ev => {
      panelEl.addEventListener(ev, e => e.stopPropagation());
    });

    const header = document.createElement("h3");
    header.innerHTML = '<span>Unified Physics v4</span><span style="font-size:11px;color:#7e8ba8;cursor:pointer;" id="upc-close-x">✕</span>';
    panelEl.appendChild(header);

    statsEl = document.createElement("div");
    statsEl.id = "upc-stats-bar";
    statsEl.textContent = "Tick: 0.00 ms | Bonds: 0 | Neutrons: 0";
    panelEl.appendChild(statsEl);

    // Quick Presets
    const presetRow = document.createElement("div");
    presetRow.className = "upc-presets";
    [
      ["default", "Balanced Default"],
      ["stellar", "Stellar / Supernova"],
      ["reactor", "Reactor & Chem"],
      ["fast", "High-FPS Mode"]
    ].forEach(([id, label]) => {
      const b = document.createElement("button");
      b.className = "upc-act";
      b.textContent = label;
      b.onclick = () => applyPreset(id);
      presetRow.appendChild(b);
    });
    panelEl.appendChild(presetRow);

    function addSection(title) {
      const s = document.createElement("div");
      s.className = "upc-sec";
      s.textContent = title;
      panelEl.appendChild(s);
    }

    function addSelect(label, key, options) {
      const row = document.createElement("div");
      row.className = "upc-row";
      const lbl = document.createElement("label");
      lbl.textContent = label;
      const sel = document.createElement("select");
      options.forEach(([val, text]) => {
        const opt = document.createElement("option");
        opt.value = String(val);
        opt.textContent = text;
        sel.appendChild(opt);
      });
      sel.value = String(UPC_CONFIG[key]);
      sel.onchange = () => {
        const parsed = Number(sel.value);
        UPC_CONFIG[key] = Number.isNaN(parsed) ? sel.value : parsed;
        applyUPCConfig(true);
      };
      uiControls[key] = sel;
      row.appendChild(lbl);
      row.appendChild(sel);
      panelEl.appendChild(row);
    }

    function addSlider(label, key, min, max, step) {
      const row = document.createElement("div");
      row.className = "upc-row";
      const lbl = document.createElement("label");
      lbl.textContent = label;
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.value = String(UPC_CONFIG[key]);
      const val = document.createElement("span");
      val.className = "upc-val";
      val.textContent = String(UPC_CONFIG[key]);
      inp._valLabel = val;
      inp.oninput = () => {
        UPC_CONFIG[key] = Number(inp.value);
        val.textContent = inp.value;
        applyUPCConfig(true);
      };
      uiControls[key] = inp;
      row.appendChild(lbl);
      row.appendChild(inp);
      row.appendChild(val);
      panelEl.appendChild(row);
    }

    function addToggle(label, key) {
      const row = document.createElement("div");
      row.className = "upc-row";
      const lbl = document.createElement("label");
      lbl.textContent = label;
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = !!UPC_CONFIG[key];
      chk.onchange = () => {
        UPC_CONFIG[key] = chk.checked;
        applyUPCConfig(true);
      };
      uiControls[key] = chk;
      row.appendChild(lbl);
      row.appendChild(chk);
      panelEl.appendChild(row);
    }

    addSection("Gravity & Tile Engine");
    addSelect("Gravity Method", "gravityMethod", [
      ["element", "Element-Based (star_gravity / wells)"],
      ["star", "Multi-Body Tiles (Always On)"],
      ["com", "Fast Single Center-of-Mass"],
      ["wells_only", "Gravity Wells / Cores Only"],
      ["off", "Off (Vanilla Only)"]
    ]);
    addSelect("Tile Resolution", "fieldTileSize", [
      [2, "2x2 (Ultra Sharp)"],
      [4, "4x4 (Balanced)"],
      [6, "6x6 (Fast)"],
      [8, "8x8 (Max FPS)"]
    ]);
    addSlider("Rebuild Every (ticks)", "fieldRebuildInterval", 1, 6, 1);
    addSlider("Gravity Strength", "gravAccel", 0, 0.12, 0.004);
    addSlider("Max Pixel Speed", "maxSpeed", 0.5, 3.5, 0.1);
    addSlider("Orbital Drag", "starDrag", 0.94, 1.0, 0.002);

    addSection("Magnets & Plasma");
    addSlider("Magnetic Strength", "magScale", 0, 3.0, 0.1);
    addToggle("Tokamak Plasma Confinement", "plasmaConfinement");
    addToggle("Curie Temp Demagnetization", "curieDemagnetize");
    addToggle("Show Field Vectors Overlay", "showFields");

    addSection("Nuclear & Fusion");
    addSlider("Fusion Rate", "fusionRate", 0, 3.0, 0.1);
    addSlider("Fission Heat Scale", "fissionHeatScale", 0.2, 3.0, 0.1);
    addSlider("Neutron Cap", "maxNeutrons", 60, 800, 20);
    addToggle("Delayed Neutrons", "delayedNeutrons");
    addToggle("Supernova Core Collapse", "supernovaEnabled");

    addSection("Chemical Bonding");
    addToggle("Auto Chemical Bonding", "autoBonding");
    addToggle("Render Bond Lines", "showBonds");
    addSlider("Max Bond Edges", "maxBonds", 0, 1800, 50);

    // Action buttons
    const actRow = document.createElement("div");
    actRow.className = "upc-presets";
    const clearBondBtn = document.createElement("button");
    clearBondBtn.className = "upc-act";
    clearBondBtn.textContent = "Break All Bonds";
    clearBondBtn.onclick = () => { clearAllBonds(); notifyUser("Cleared all chemical bonds."); };

    const zeroVelBtn = document.createElement("button");
    zeroVelBtn.className = "upc-act";
    zeroVelBtn.textContent = "Zero All Velocity";
    zeroVelBtn.onclick = () => {
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (p) { p.vx = 0; p.vy = 0; p.rx = 0; p.ry = 0; }
      }
      movingPixelsLastTick = 0;
      notifyUser("Zeroed velocity on all pixels.");
    };
    actRow.appendChild(clearBondBtn);
    actRow.appendChild(zeroVelBtn);
    panelEl.appendChild(actRow);

    document.body.appendChild(panelEl);

    const togglePanel = () => {
      const open = panelEl.style.display === "block";
      panelEl.style.display = open ? "none" : "block";
      if (!open) syncSettingsUI();
    };

    btn.onclick = (e) => { e.stopPropagation(); togglePanel(); };
    const closeX = document.getElementById("upc-close-x");
    if (closeX) closeX.onclick = togglePanel;

    window.addEventListener("keydown", function (e) {
      if (e.shiftKey && (e.key === "P" || e.key === "p")) {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        togglePanel();
      }
    });

    // Lightweight 2Hz telemetry refresh only while panel is open
    setInterval(function () {
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
      const gravMode = new SelectSetting("Gravity Method", "upc_grav_method", [
        ["element", "Element-Based"],
        ["star", "Multi-Body Always On"],
        ["com", "Fast Center-of-Mass"],
        ["wells_only", "Wells/Cores Only"],
        ["off", "Off"]
      ]);
      const tileSize = new SelectSetting("Gravity/Magnet Tile Size", "upc_tile_size", [
        [2, "2x2"], [4, "4x4"], [6, "6x6"], [8, "8x8"]
      ]);
      const bind = (s, key) => {
        if (s && typeof s.onUpdate === "function") {
          s.onUpdate(val => { UPC_CONFIG[key] = val; applyUPCConfig(true); });
        }
        if (typeof tab.registerSetting === "function") tab.registerSetting(s);
      };
      bind(gravMode, "gravityMethod");
      bind(tileSize, "fieldTileSize");
      if (typeof Setting === "function" && typeof settingType !== "undefined") {
        bind(new Setting("Auto Chemical Bonding", "upc_auto_bond", settingType.BOOLEAN, false, UPC_CONFIG.autoBonding), "autoBonding");
        bind(new Setting("Show Field Vectors", "upc_show_fields", settingType.BOOLEAN, false, UPC_CONFIG.showFields), "showFields");
      }
      settingsManager.registerTab(tab);
    } catch (err) {
      // Built-in Physics Settings panel still works independently
    }
  }

  // ---------------------------------------------------------------------------
  // 12. PATCH VANILLA & CHEM.JS + HOOK GLOBAL ENGINE
  // ---------------------------------------------------------------------------

  function initUnifiedPhysics() {
    applyUPCConfig(false);

    // 1. Iron gas state for stellar cores
    if (!elements.iron_gas) {
      registerOrEnhance("iron_gas", {
        color: ["#ffb870", "#ffc98f"],
        behavior: behaviors.GAS,
        category: "states",
        state: "gas",
        hidden: true,
        density: 7.8,
        temp: 2950,
        tempLow: 2862,
        stateLow: "molten_iron"
      });
    }
    if (elements.molten_iron && !elements.molten_iron.stateHigh) {
      elements.molten_iron.tempHigh = 2862;
      elements.molten_iron.stateHigh = "iron_gas";
    }

    // 2. Patch vanilla neutron, uranium, plutonium
    if (elements.neutron) {
      elements.neutron.desc = "Free neutron (enhanced by Unified Physics & Chemistry v4).";
      if (!elements.neutron.reactions) elements.neutron.reactions = {};
      elements.neutron.tick = function (pixel) { neutronTick(pixel, true); };
    }
    if (elements.uranium) {
      elements.uranium.desc = "Natural/Low-Enriched Uranium (patched). Requires moderated thermal neutrons for sustained fission.";
      elements.uranium.tick = function (pixel) {
        if (Math.random() < 0.0001) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        doDefaults(pixel);
      };
    }
    if (elements.plutonium) {
      elements.plutonium.desc = "Plutonium-239 (patched). Self-heats via alpha decay; fissions on thermal & fast neutrons.";
      elements.plutonium.tick = function (pixel) {
        pixel.temp += 0.05;
        if (Math.random() < 0.0005) spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        doDefaults(pixel);
      };
    }

    // 3. Stellar Fusion Hooks on Vanilla Gases (all inside tick -> crash-proof!)
    if (elements.hydrogen) {
      wrapTick("hydrogen", function (pixel) {
        if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 50000 && Math.random() < 0.16 * UPC_CONFIG.fusionRate) {
          const other = findAdjacentElement(pixel, "hydrogen");
          if (other) {
            safeChange(pixel, "deuterium");
            safeChangeAny(other, ["positron", "gamma_ray", "radiation"]);
            pixel.temp += 4000; other.temp += 4000;
            return true;
          }
        }
        return false;
      });
    }

    if (elements.helium) {
      wrapTick("helium", function (pixel) {
        if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 65000 && Math.random() < 0.15 * UPC_CONFIG.fusionRate) {
          const other = findAdjacentElement(pixel, "helium");
          if (other) {
            safeChange(pixel, "carbon_vapor");
            safeChange(other, "gamma_ray");
            pixel.temp += 5500; other.temp += 5500;
            return true;
          }
        }
        return false;
      });
    }

    if (elements.oxygen) {
      wrapTick("oxygen", function (pixel) {
        if (UPC_CONFIG.fusionRate > 0 && pixel.temp >= 95000 && Math.random() < 0.16 * UPC_CONFIG.fusionRate) {
          const other = findAdjacentElement(pixel, "oxygen");
          if (other) {
            if (Math.random() < 0.75) {
              safeChange(pixel, "silicon_gas");
            } else {
              safeChangeAny(pixel, ["sulfur_gas", "molten_sulfur", "sulfur", "silicon_gas"]);
            }
            safeChange(other, "gamma_ray");
            pixel.temp += 4000; other.temp += 4000;
            return true;
          }
        }
        return false;
      });
    }

    // 4. High-Temperature Thermal Dissociation
    if (elements.carbon_dioxide) {
      wrapTick("carbon_dioxide", function (pixel) {
        if (pixel.temp >= 4000 && Math.random() < 0.25) {
          safeChange(pixel, Math.random() < 0.5 ? "carbon_vapor" : "oxygen");
          return true;
        }
        return false;
      });
    }
    if (elements.steam) {
      wrapTick("steam", function (pixel) {
        if (pixel.temp >= 3200 && Math.random() < 0.20) {
          safeChange(pixel, Math.random() < 0.66 ? "hydrogen" : "oxygen");
          return true;
        }
        return false;
      });
    }
    if (elements.ammonia) {
      wrapTick("ammonia", function (pixel) {
        if (pixel.temp >= 1200 && Math.random() < 0.22) {
          safeChange(pixel, Math.random() < 0.75 ? "hydrogen" : "nitrogen");
          return true;
        }
        return false;
      });
    }
    if (elements.sand) {
      wrapTick("sand", function (pixel) {
        if (pixel.temp >= 4500 && Math.random() < 0.18) {
          safeChange(pixel, Math.random() < 0.45 ? "silicon_gas" : "oxygen");
          return true;
        }
        return false;
      });
    }

    // 5. Thermite Reaction (Rust + Aluminum > 1,200 C)
    if (elements.rust && elements.aluminum) {
      safeAddReaction("rust", "aluminum", {
        elem1: "molten_iron",
        elem2: "alumina",
        tempMin: 1200,
        chance: 0.45,
        func: function (p1, p2) { p1.temp += 1800; p2.temp += 1800; }
      });
    }

    // 6. chem.js uranium_dioxide integration
    if (elements.uranium_dioxide) {
      FISSILE_SPECS.uranium_dioxide = {
        thermalProb: 0.45,
        fastProb: 0.04,
        neutrons: [2, 3],
        heat: 1850,
        daughters: ["barium_141", "krypton_92", "xenon_135"]
      };
    }

    // 7. Hook global simulation tick with live timing
    if (typeof window !== "undefined" && typeof window.tickPixels === "function" && !window.tickPixels._upcWrapped) {
      const origTickPixels = window.tickPixels;
      const wrappedTick = function (...args) {
        const res = origTickPixels.apply(this, args);
        const t0 = performance.now();
        try {
          updateGravityAndCompressionTick();
          updateBondsTick();
        } catch (err) {
          console.error("[unified_physics_chem] global tick error:", err);
        }
        UPC_STATS.lastTickMs = performance.now() - t0;
        return res;
      };
      wrappedTick._upcWrapped = true;
      window.tickPixels = wrappedTick;
    }

    // 8. Hook canvas render for field vectors & chemical bond lines
    if (typeof window !== "undefined" && typeof window.drawPixels === "function" && !window.drawPixels._upcWrapped) {
      const origDrawPixels = window.drawPixels;
      const wrappedDraw = function (...args) {
        const res = origDrawPixels.apply(this, args);
        try {
          drawFieldOverlay();
          drawActiveBonds();
        } catch (err) {}
        return res;
      };
      wrappedDraw._upcWrapped = true;
      window.drawPixels = wrappedDraw;
    }

    // 9. Global safety sweep (preserves tools; strips any non-function tick)
    for (const key in elements) {
      const el = elements[key];
      if (!el || el.tool) continue;
      if (el.tick !== undefined && typeof el.tick !== "function") {
        delete el.tick;
      }
      if (!el.reactions) el.reactions = {};
      if (!el.behavior && !el.tick) {
        el.behavior = el.state === "liquid" ? behaviors.LIQUID
          : el.state === "gas" ? behaviors.GAS
          : behaviors.WALL;
      }
    }

    // 10. Mount built-in Settings Panel & optional betterSettings.js tab
    createSettingsUI();
    if (typeof SettingsTab === "function") {
      registerBetterSettingsTab();
    } else if (typeof dependOn === "function") {
      dependOn("betterSettings.js", registerBetterSettingsTab, true);
    }

    console.log("[unified_physics_chem] Loaded v4 successfully!");
  }

  if (typeof runAfterLoad === "function") {
    runAfterLoad(initUnifiedPhysics);
  } else {
    initUnifiedPhysics();
  }
})();
