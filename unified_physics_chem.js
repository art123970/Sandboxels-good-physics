/*
 * Unified Physics & Chemistry (unified_physics_chem.js)
 * Companion add-on for Sandboxels + chem.js
 *
 * Systems:
 *  1. Full Elements & Isotopes (Solid / Liquid-Molten / Gas chains + accurate phase temps)
 *  2. Crash-Proof Nuclear Fission (fast/thermal neutrons, moderation, reflectors, control rods,
 *     Doppler feedback, delayed neutrons, Xe-135 poisoning, U-238/Th-232/Li-6 breeders)
 *  3. Complete Stellar & Reactor Fusion Ladder (D-T, D-D, D-He3, He3-He3, p-p, Triple-Alpha,
 *     C+He->O, C+C->Ne/Mg, Ne+He->Mg, O+O->Si/S, Si+He->Ni-56->Co-56->Fe, Supernova r-process)
 *  4. Gravity, Adiabatic Compression & Supernova Core Collapse (star_gravity, gravity_well, neutronium)
 *  5. Persistent 2-Pixel Chemical Bonding Engine (auto covalent/ionic + manual bond_catalyst,
 *     visual bond lines, bond breaking via heat, electricity, radiation, water, shear, or bond_breaker)
 *  6. Realistic North/South Pole Magnetism (opposite attract, like repel, ferromagnetic-only pull,
 *     Curie-temperature demagnetization, electromagnets, Gadolinium 20 C switch, Superconductor Meissner)
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. CORE SAFETY UTILITIES & FULL STATE-CHAIN BUILDERS
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

  function safeChange(pixel, elemName) {
    if (!pixel || pixel.del) return false;
    if (!elements[elemName]) return false;
    changePixel(pixel, elemName);
    return true;
  }

  function safeChangeAny(pixel, candidates) {
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
    if (!el) return;
    const prevTick = typeof el.tick === "function" ? el.tick : null;
    el.tick = function (pixel) {
      if (!pixel || pixel.del) return;
      if (extraFn(pixel) === true) return;
      if (pixel.del) return;
      if (prevTick) {
        prevTick(pixel);
      } else {
        doDefaults(pixel);
      }
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
    if (!clean.reactions) clean.reactions = {};

    if (elements[name]) {
      const existing = elements[name];
      existing.reactions = Object.assign({}, existing.reactions || {}, clean.reactions);
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
  // 2. PERSISTENT 2-PIXEL CHEMICAL BONDING ENGINE
  // ---------------------------------------------------------------------------

  const MAX_BONDS = 650;
  const bondedPixels = new Set();
  let totalBondEdges = 0;

  // Automatic chemical bond definitions (keeps both pixels intact & linked!)
  // Key format: sorted "elemA|elemB"
  const AUTO_BOND_RULES = {
    "hydrogen|hydrogen":     { type: "covalent", breakTemp: 3500, minTemp: -250, maxTemp: 2500, prob: 0.08, maxValenceA: 1, maxValenceB: 1 },
    "hydrogen|oxygen":       { type: "polar",    breakTemp: 2800, minTemp: 150,  maxTemp: 2200, prob: 0.14, maxValenceA: 1, maxValenceB: 2 },
    "deuterium|oxygen":      { type: "polar",    breakTemp: 2850, minTemp: 150,  maxTemp: 2200, prob: 0.14, maxValenceA: 1, maxValenceB: 2 },
    "chlorine|sodium":       { type: "ionic",    breakTemp: 1450, minTemp: -50,  maxTemp: 1100, prob: 0.22, maxValenceA: 1, maxValenceB: 1 },
    "chlorine|hydrogen":     { type: "polar",    breakTemp: 2200, minTemp: -100, maxTemp: 1600, prob: 0.14, maxValenceA: 1, maxValenceB: 1 },
    "nitrogen|nitrogen":     { type: "covalent", breakTemp: 5500, minTemp: -200, maxTemp: 4000, prob: 0.06, maxValenceA: 1, maxValenceB: 1 },
    "hydrogen|nitrogen":     { type: "polar",    breakTemp: 1300, minTemp: 350,  maxTemp: 900,  prob: 0.08, maxValenceA: 1, maxValenceB: 3 },
    "carbon_vapor|oxygen":   { type: "covalent", breakTemp: 3800, minTemp: 600,  maxTemp: 3200, prob: 0.12, maxValenceA: 2, maxValenceB: 2 },
    "graphite|graphite":     { type: "covalent", breakTemp: 4200, minTemp: 800,  maxTemp: 3400, prob: 0.04, maxValenceA: 3, maxValenceB: 3 },
    "silicon|silicon":       { type: "covalent", breakTemp: 2600, minTemp: 200,  maxTemp: 2200, prob: 0.04, maxValenceA: 4, maxValenceB: 4 },
    "oxygen|silicon":        { type: "covalent", breakTemp: 3000, minTemp: 700,  maxTemp: 2400, prob: 0.10, maxValenceA: 2, maxValenceB: 4 },
    "magnesium|oxygen":      { type: "ionic",    breakTemp: 2800, minTemp: 400,  maxTemp: 2300, prob: 0.18, maxValenceA: 2, maxValenceB: 2 },
    "cesium|chlorine":       { type: "ionic",    breakTemp: 1300, minTemp: -50,  maxTemp: 900,  prob: 0.25, maxValenceA: 1, maxValenceB: 1 }
  };

  function getBondKey(e1, e2) {
    return e1 < e2 ? e1 + "|" + e2 : e2 + "|" + e1;
  }

  function hasBondBetween(p1, p2) {
    if (!p1.bonds) return false;
    for (let i = 0; i < p1.bonds.length; i++) {
      if (p1.bonds[i].target === p2) return true;
    }
    return false;
  }

  function createBond(p1, p2, type = "covalent", breakTemp = 2500) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del) return false;
    if (totalBondEdges >= MAX_BONDS) return false;
    if (hasBondBetween(p1, p2)) return false;

    if (!p1.bonds) p1.bonds = [];
    if (!p2.bonds) p2.bonds = [];
    if (p1.bonds.length >= 4 || p2.bonds.length >= 4) return false;

    p1.bonds.push({ target: p2, type, breakTemp });
    p2.bonds.push({ target: p1, type, breakTemp });
    bondedPixels.add(p1);
    bondedPixels.add(p2);
    totalBondEdges++;

    // Exothermic bond formation releases a small packet of energy
    p1.temp += 18;
    p2.temp += 18;
    return true;
  }

  function breakBondBetween(p1, p2, endothermic = true) {
    let removed = false;
    if (p1 && p1.bonds) {
      for (let i = p1.bonds.length - 1; i >= 0; i--) {
        if (p1.bonds[i].target === p2) {
          p1.bonds.splice(i, 1);
          removed = true;
        }
      }
      if (p1.bonds.length === 0) bondedPixels.delete(p1);
    }
    if (p2 && p2.bonds) {
      for (let i = p2.bonds.length - 1; i >= 0; i--) {
        if (p2.bonds[i].target === p1) {
          p2.bonds.splice(i, 1);
          removed = true;
        }
      }
      if (p2.bonds.length === 0) bondedPixels.delete(p2);
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
    if (!pixel || !pixel.bonds) return;
    const copy = pixel.bonds.slice();
    for (let i = 0; i < copy.length; i++) {
      breakBondBetween(pixel, copy[i].target, false);
    }
  }

  function isImmobileElement(elemName) {
    const el = elements[elemName];
    if (!el) return true;
    return el.behavior === behaviors.WALL || elemName === "gravity_well" || elemName === "star_gravity" || elemName === "neutronium";
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
      const nx = candidates[i][0];
      const ny = candidates[i][1];
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
    // 1. Maintain existing bonds & evaluate bond breaking (heat, electricity, radiation, water, shear)
    if (bondedPixels.size > 0) {
      const toVisit = Array.from(bondedPixels);
      for (let i = 0; i < toVisit.length; i++) {
        const p = toVisit[i];
        if (!p || p.del || !inSafeBounds(p.x, p.y) || pixelMap[p.x][p.y] !== p || !p.bonds || p.bonds.length === 0) {
          breakAllBonds(p);
          bondedPixels.delete(p);
          continue;
        }

        // Check environmental breakers (radiation, fast_neutron, bond_breaker, water for ionic)
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
          else if (adj.element === "radiation" || adj.element === "fast_neutron") hitRad = true;
          else if (adj.element === "water") hitWater = true;
        }

        if (hitBreaker) {
          breakAllBonds(p);
          continue;
        }

        for (let j = p.bonds.length - 1; j >= 0; j--) {
          const bond = p.bonds[j];
          const t = bond.target;

          if (!t || t.del || !inSafeBounds(t.x, t.y) || pixelMap[t.x][t.y] !== t) {
            breakBondBetween(p, t, false);
            continue;
          }

          const dist = Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y));

          // Break condition A: Mechanical shear (pulled > 3 cells apart)
          if (dist > 3) {
            breakBondBetween(p, t, true);
            continue;
          }

          // Break condition B: Thermal cleavage
          if (p.temp > bond.breakTemp || t.temp > bond.breakTemp) {
            breakBondBetween(p, t, true);
            continue;
          }

          // Break condition C: Electrolysis / electrical shock
          if ((p.charge && p.charge > 0) || (t.charge && t.charge > 0)) {
            if (bond.type === "ionic" || bond.type === "polar" || Math.random() < 0.4) {
              breakBondBetween(p, t, true);
              continue;
            }
          }

          // Break condition D: Radiolysis (ionizing radiation / fast neutron)
          if (hitRad && Math.random() < 0.35) {
            breakBondBetween(p, t, true);
            continue;
          }

          // Break condition E: Water dissolves ionic bonds (e.g. Na-Cl)
          if (bond.type === "ionic" && hitWater && Math.random() < 0.18) {
            breakBondBetween(p, t, true);
            continue;
          }

          // Heat equalization across bond
          const avgT = (p.temp + t.temp) * 0.5;
          p.temp += (avgT - p.temp) * 0.25;
          t.temp += (avgT - t.temp) * 0.25;

          // Keep the two bonded pixels tethered within 1 cell
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

    // 2. Sample automatic chemical bonding across canvas (fast O(1) capped budget)
    if (totalBondEdges < MAX_BONDS && currentPixels && currentPixels.length > 0) {
      const samples = Math.min(80, currentPixels.length);
      for (let s = 0; s < samples; s++) {
        if (totalBondEdges >= MAX_BONDS) break;
        const p = currentPixels[Math.floor(Math.random() * currentPixels.length)];
        if (!p || p.del || (p.bonds && p.bonds.length >= 3)) continue;

        const dir = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        const nx = p.x + dir[0];
        const ny = p.y + dir[1];
        if (!inSafeBounds(nx, ny)) continue;
        const q = pixelMap[nx][ny];
        if (!q || q.del || (q.bonds && q.bonds.length >= 3)) continue;

        const key = getBondKey(p.element, q.element);
        const rule = AUTO_BOND_RULES[key];
        if (!rule) continue;

        const avgTemp = (p.temp + q.temp) * 0.5;
        if (avgTemp < rule.minTemp || avgTemp > rule.maxTemp) continue;

        const firstIsA = p.element <= q.element;
        const maxA = firstIsA ? rule.maxValenceA : rule.maxValenceB;
        const maxB = firstIsA ? rule.maxValenceB : rule.maxValenceA;
        if ((p.bonds?.length || 0) >= maxA || (q.bonds?.length || 0) >= maxB) continue;

        if (Math.random() < rule.prob) {
          createBond(p, q, rule.type, rule.breakTemp);
        }
      }
    }
  }

  function drawActiveBonds() {
    if (bondedPixels.size === 0) return;
    if (typeof ctx === "undefined" || !ctx || typeof pixelSize !== "number") return;

    ctx.save();
    ctx.lineWidth = Math.max(1, pixelSize * 0.26);
    ctx.lineCap = "round";

    bondedPixels.forEach(function (p) {
      if (!p || p.del || !p.bonds) return;
      for (let i = 0; i < p.bonds.length; i++) {
        const bond = p.bonds[i];
        const t = bond.target;
        if (!t || t.del) continue;
        // Draw each undirected edge only once
        if (p.x > t.x || (p.x === t.x && p.y >= t.y)) continue;

        if (bond.type === "ionic") ctx.strokeStyle = "rgba(255, 215, 90, 0.85)";
        else if (bond.type === "polar") ctx.strokeStyle = "rgba(110, 225, 255, 0.85)";
        else if (bond.type === "catalyst") ctx.strokeStyle = "rgba(140, 255, 130, 0.9)";
        else ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";

        ctx.beginPath();
        ctx.moveTo((p.x + 0.5) * pixelSize, (p.y + 0.5) * pixelSize);
        ctx.lineTo((t.x + 0.5) * pixelSize, (t.y + 0.5) * pixelSize);
        ctx.stroke();
      }
    });

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 3 & 4. UNIFIED 4x4 PRECOMPUTED GRAVITY + MAGNETIC FIELDS & PER-PIXEL VELOCITY
  // ---------------------------------------------------------------------------

  const IRON_FAMILY = new Set(["iron", "molten_iron", "iron_gas"]);
  const SUPER_R_PROCESS_TARGETS = new Set(["iron", "molten_iron", "iron_gas", "nickel", "molten_nickel", "nickel_gas", "cobalt", "molten_cobalt"]);
  const R_PROCESS_PRODUCTS = ["gold", "platinum", "lead", "thorium_232", "uranium_238", "uranium_235", "plutonium_239"];

  // Curie temperatures in Celsius: above this temp, material loses ferromagnetism
  const FERROMAGNETIC_CURIE = {
    iron: 770,
    molten_iron: 770,
    iron_filings: 770,
    steel: 750,
    cobalt: 1115,
    cobalt_60: 1115,
    nickel: 358,
    neodymium: 310,
    gadolinium: 20,
    rust: 580,
    metal_scrap: 750
  };

  // Pole sign (+1 = North, -1 = South) & relative field strength
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
    electromagnet_north: 1.8,
    electromagnet_south: -1.8,
    magnet_bead_n: 0.45,
    magnet_bead_s: -0.45
  };

  const VELOCITY_EXEMPT = new Set([
    "fast_neutron", "thermal_neutron", "radiation", "bond_breaker", "bond_catalyst"
  ]);

  const FIELD_BLOCK = 4;             // 4x4 macro-voxels -> 256x faster convolution
  const FIELD_SOFTENING = 0.85;      // Prevents singularity at r = 0
  const FIELD_REBUILD_INTERVAL = 2;  // Refresh both 4x4 fields every 2 ticks
  const MAX_SPEED = 2.6;             // Sub-stepped up to 3x -> zero wall tunneling
  const GRAV_ACCEL = 0.032;
  const MAG_POLE_ACCEL = 0.18;
  const MAG_FERRO_ACCEL = 0.55;
  const MAG_MEISSNER_ACCEL = 0.70;

  let fieldMw = 0, fieldMh = 0, fieldKw = 0;
  let kernelX = null, kernelY = null, kernelPhi = null;

  // Gravity macro-grids
  let macroMass = null, macroGx = null, macroGy = null, macroPhi = null;
  let macroIron = null, macroHotIron = null;

  // Magnetic macro-grids
  let macroPole = null, macroMagAbs = null;
  let macroBx = null, macroBy = null, macroMagPot = null, macroBmag = null;
  let macroGradBx = null, macroGradBy = null;

  let lastFieldTick = -100;
  let lastSupernovaTick = -200;
  let gravFieldActive = false;
  let magFieldActive = false;
  let starModeActive = false;
  let movingPixelsLastTick = 0;
  let patchedSuperconductor = false;

  // No-op stub so Section 6 magnet ticks stay valid with zero wasted CPU
  function applyMagneticField() {}

  function isFerromagneticNow(pixel) {
    const curie = FERROMAGNETIC_CURIE[pixel.element];
    return curie !== undefined && pixel.temp <= curie;
  }

  function stepAway(mover, srcX, srcY) {
    if (!mover || mover.del || isImmobileElement(mover.element)) return false;
    const dx = Math.sign(mover.x - srcX);
    const dy = Math.sign(mover.y - srcY);
    if (dx === 0 && dy === 0) return false;
    const candidates = [
      [mover.x + dx, mover.y + dy],
      [mover.x + dx, mover.y],
      [mover.x, mover.y + dy]
    ];
    for (let i = 0; i < candidates.length; i++) {
      const nx = candidates[i][0], ny = candidates[i][1];
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

  function ensureFieldTables() {
    if (!patchedSuperconductor && elements.superconductor) {
      patchedSuperconductor = true;
      // Let the unified -grad|B| engine drive Meissner levitation cleanly
      elements.superconductor.tick = function (pixel) { doDefaults(pixel); };
    }

    const mw = Math.max(2, Math.ceil((width + 1) / FIELD_BLOCK));
    const mh = Math.max(2, Math.ceil((height + 1) / FIELD_BLOCK));
    if (mw === fieldMw && mh === fieldMh && kernelX) return;

    fieldMw = mw;
    fieldMh = mh;
    const kw = 2 * mw - 1;
    const kh = 2 * mh - 1;
    fieldKw = kw;

    kernelX = new Float32Array(kw * kh);
    kernelY = new Float32Array(kw * kh);
    kernelPhi = new Float32Array(kw * kh);

    // Precompute unit-source kernel once: points toward source (-dx/r^3, -dy/r^3)
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
  }

  function sampleField(arr, x, y) {
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

  // Bilinear sample that subtracts a moving source's own contribution at all 4 corners
  // (eliminates Particle-Mesh self-acceleration completely!)
  function sampleFieldMinusSelf(arr, x, y, selfBx, selfBy, selfCoeff, kArr) {
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

  function triggerSupernova(cx, cy) {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t - lastSupernovaTick < 60) return;
    lastSupernovaTick = t;

    // 1. Core collapses into degenerate Neutronium
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx * dx + dy * dy > 5) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (p && !p.del) {
          safeChange(p, "neutronium");
          p.temp = 120000;
        } else if (isEmpty(nx, ny)) {
          const np = safeCreate("neutronium", nx, ny);
          if (np) np.temp = 120000;
        }
      }
    }

    // 2. Supernova shockwave (imparts real radial velocity!) + r-process synthesis
    const shockR = 16;
    for (let dx = -shockR; dx <= shockR; dx++) {
      for (let dy = -shockR; dy <= shockR; dy++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= 6 || d2 > shockR * shockR) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (!p || p.del || p.element === "neutronium" || p.element === "star_gravity") continue;

        const dist = Math.sqrt(d2);
        p.temp += Math.round(45000 / dist);

        if (SUPER_R_PROCESS_TARGETS.has(p.element) && Math.random() < 0.42) {
          const heavy = R_PROCESS_PRODUCTS[Math.floor(Math.random() * R_PROCESS_PRODUCTS.length)];
          safeChange(p, heavy);
        }

        if (!isImmobileElement(p.element)) {
          const kick = Math.min(MAX_SPEED, 14 / dist);
          p.vx = (p.vx || 0) + (dx / dist) * kick;
          p.vy = (p.vy || 0) + (dy / dist) * kick;
        }
      }
    }

    spawnNeutronsAround(cx, cy, 24, "fast_neutron");
    explodeAt(cx, cy, 11, "plasma,radiation,fire");
  }

  function rebuildFields() {
    ensureFieldTables();

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

    // Pass 1: Single O(N) bin pass for BOTH gravity mass and magnetic poles
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del) continue;
      const e = p.element;

      if (e === "star_gravity") {
        hasStarGravity = true;
        continue;
      }

      const bx = (p.x / FIELD_BLOCK) | 0;
      const by = (p.y / FIELD_BLOCK) | 0;
      if (bx < 0 || bx >= fieldMw || by < 0 || by >= fieldMh) continue;
      const bIdx = by * fieldMw + bx;

      // Magnetic pole binning
      const magStr = MAGNET_STRENGTH[e];
      if (magStr !== undefined) {
        const isElectro = e === "electromagnet_north" || e === "electromagnet_south";
        if (!isElectro || (p.charge && p.charge > 0)) {
          macroPole[bIdx] += magStr;
          macroMagAbs[bIdx] += Math.abs(magStr);
          hasMagnets = true;
        }
      }

      // Gravity mass binning
      if (e === "gravity_well") {
        hasPointWell = true;
        macroMass[bIdx] += 45;
      } else if (e === "neutronium") {
        hasPointWell = true;
        macroMass[bIdx] += 95;
      } else if (!isImmobileElement(e)) {
        const dens = elements[e]?.density || 100;
        macroMass[bIdx] += Math.min(12, Math.max(0.35, dens / 1000));
        if (IRON_FAMILY.has(e)) {
          macroIron[bIdx]++;
          if (p.temp > 85000) macroHotIron[bIdx]++;
        }
      }
    }

    starModeActive = hasStarGravity;
    gravFieldActive = hasStarGravity || hasPointWell;
    magFieldActive = hasMagnets;

    if (!hasStarGravity && hasPointWell) {
      macroMass.fill(0);
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del) continue;
        if (p.element !== "gravity_well" && p.element !== "neutronium") continue;
        const bx = (p.x / FIELD_BLOCK) | 0;
        const by = (p.y / FIELD_BLOCK) | 0;
        if (bx >= 0 && bx < fieldMw && by >= 0 && by < fieldMh) {
          macroMass[by * fieldMw + bx] += p.element === "neutronium" ? 95 : 45;
        }
      }
    }

    if (!gravFieldActive && !magFieldActive) return;

    // Pass 2: Shared cache-friendly convolution over non-empty macro-cells
    const mw = fieldMw, mh = fieldMh, kw = fieldKw;
    for (let sy = 0; sy < mh; sy++) {
      const sRow = sy * mw;
      for (let sx = 0; sx < mw; sx++) {
        const sIdx = sRow + sx;
        const m = gravFieldActive ? macroMass[sIdx] : 0;
        const q = magFieldActive ? macroPole[sIdx] : 0;
        const qAbs = magFieldActive ? macroMagAbs[sIdx] : 0;
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

    // Pass 2b: Compute |B| and its gradient (for ferromagnetic pull & Meissner repulsion)
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

    // Pass 2c: Independent local Supernova collapse check per iron core
    if (gravFieldActive) {
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
            triggerSupernova(bx * FIELD_BLOCK + 2, by * FIELD_BLOCK + 2);
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

      let nx = p.x + sx;
      let ny = p.y + sy;

      // Try diagonal first, then slide along unblocked axis if corner-clipped
      if (!inSafeBounds(nx, ny)) {
        p.vx = sx !== 0 ? 0 : p.vx;
        p.vy = sy !== 0 ? 0 : p.vy;
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

        // Buoyancy / density stratification through gases and liquids
        if ((tState === "gas" || tState === "liquid") && pDens > tDens * 1.15) {
          safeSwap(p, target);
          p.vx *= 0.88;
          p.vy *= 0.88;
          remX -= sx;
          remY -= sy;
          continue;
        }

        // Inelastic momentum transfer on collision
        const totalM = pDens + tDens;
        const tvx = target.vx || 0, tvy = target.vy || 0;
        const newVx = (pDens * p.vx + tDens * tvx) / totalM;
        const newVy = (pDens * p.vy + tDens * tvy) / totalM;
        p.vx = newVx * 0.80;
        p.vy = newVy * 0.80;
        target.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, tvx + (newVx - tvx) * 1.15));
        target.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, tvy + (newVy - tvy) * 1.15));
        break;
      } else {
        // Immobile wall / magnet impact: damp normal axis, allow gentle tangential glide
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

    if (!gravFieldActive && !magFieldActive && movingPixelsLastTick === 0) return;

    let movingNow = 0;

    // Pass 3: Deterministic per-pixel velocity integration & adiabatic compression
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del || isImmobileElement(p.element)) continue;
      if (VELOCITY_EXEMPT.has(p.element)) continue;

      let ax = 0;
      let ay = 0;
      const selfBx = (p.x / FIELD_BLOCK) | 0;
      const selfBy = (p.y / FIELD_BLOCK) | 0;

      // 1. Gravity acceleration & potential-driven adiabatic compression
      if (gravFieldActive) {
        const selfM = starModeActive ? Math.min(12, Math.max(0.35, (elements[p.element]?.density || 100) / 1000)) : 0;
        const gx = selfM > 0
          ? sampleFieldMinusSelf(macroGx, p.x, p.y, selfBx, selfBy, -selfM, kernelX)
          : sampleField(macroGx, p.x, p.y);
        const gy = selfM > 0
          ? sampleFieldMinusSelf(macroGy, p.x, p.y, selfBx, selfBy, -selfM, kernelY)
          : sampleField(macroGy, p.x, p.y);

        // Hot stellar plasma radiation pressure opposes gravitational collapse
        const radPressure = p.temp > 45000 ? Math.min(0.65, (p.temp - 45000) / 140000) : 0;
        const gScale = GRAV_ACCEL * (1 - radPressure);
        ax += gx * gScale;
        ay += gy * gScale;

        // Check core compression every 2nd tick to keep inner loop lean
        if ((t & 1) === 0) {
          const phi = sampleField(macroPhi, p.x, p.y);
          if (phi > 12) {
            let surrounded = 0;
            for (let c = 0; c < adjacentCoords.length; c++) {
              const cx = p.x + adjacentCoords[c][0];
              const cy = p.y + adjacentCoords[c][1];
              if (inSafeBounds(cx, cy) && !isEmpty(cx, cy)) surrounded++;
            }
            p.pressure = Math.round(phi * surrounded * 0.6);
            if (surrounded >= 5) {
              p.temp += phi * surrounded * 0.38;
            }
          }
        }
      }

      // 2. Magnetic acceleration (poles, ferromagnets, and cooled superconductors)
      if (magFieldActive) {
        const poleSign = MAGNET_POLE_MAP[p.element];
        if (poleSign !== undefined) {
          const selfQ = MAGNET_STRENGTH[p.element] || 0;
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
        }
      }

      const prevVx = p.vx || 0;
      const prevVy = p.vy || 0;
      if (ax === 0 && ay === 0 && prevVx === 0 && prevVy === 0) continue;

      // Low drag in star mode preserves long-lived orbits; moderate drag on Earth settles piles
      const drag = starModeActive ? 0.994 : 0.94;
      let vx = (prevVx + ax) * drag;
      let vy = (prevVy + ay) * drag;

      // Clamp total speed cleanly
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
  }

  // ---------------------------------------------------------------------------
  // 5. NUCLEAR FISSION ENGINE (CRASH-PROOF NEUTRON TRANSPORT)
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
  const SHIELDING = new Set(["lead", "molten_lead", "concrete", "osmium"]);

  const MAX_NEUTRONS = 320;
  const MAX_SPAWN_PER_TICK = 40;
  const EXPLODE_COOLDOWN_TICKS = 8;

  let lastPhysicsTick = -1;
  let neutronsThisTick = 0;
  let prevTickNeutrons = 0;
  let spawnedThisTick = 0;
  let lastExplodeTick = -100;
  let loggedNeutronError = false;

  function syncPhysicsTick() {
    const t = typeof pixelTicks === "number" ? pixelTicks : 0;
    if (t !== lastPhysicsTick) {
      prevTickNeutrons = neutronsThisTick;
      neutronsThisTick = 0;
      spawnedThisTick = 0;
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
        const nx = cx + dx * dist;
        const ny = cy + dy * dist;
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

    targetPixel.temp += spec.heat;
    let nearbyFissile = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (!inSafeBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (p && !p.del) {
          p.temp += Math.round(spec.heat * 0.18);
          if (FISSILE_SPECS[p.element]) nearbyFissile++;
        }
      }
    }

    if (neutronPixel && !neutronPixel.del && inSafeBounds(neutronPixel.x, neutronPixel.y) && pixelMap[neutronPixel.x][neutronPixel.y] === neutronPixel) {
      deletePixel(neutronPixel.x, neutronPixel.y);
    }

    const nCount = spec.neutrons[0] + (Math.random() < 0.5 ? (spec.neutrons[1] - spec.neutrons[0]) : 0);
    spawnNeutronsAround(tx, ty, nCount, "fast_neutron");

    // Throttled prompt-critical hydrodynamic disassembly
    if (targetPixel.temp > 6000 && nearbyFissile >= 10 && (lastPhysicsTick - lastExplodeTick >= EXPLODE_COOLDOWN_TICKS)) {
      lastExplodeTick = lastPhysicsTick;
      explodeAt(tx, ty, 8, "plasma,fire,radiation,fallout");
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

        // A. Fission (with Doppler broadening negative temperature feedback)
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

        // B. Supernova r-process neutron capture on Iron/Nickel/Cobalt at extreme heat
        if (isFast && target.temp > 75000 && SUPER_R_PROCESS_TARGETS.has(tElem) && Math.random() < 0.40) {
          const heavy = R_PROCESS_PRODUCTS[Math.floor(Math.random() * R_PROCESS_PRODUCTS.length)];
          safeChange(target, heavy);
          deletePixel(pixel.x, pixel.y);
          return;
        }

        // C. Fertile breeding (U-238 -> Np-239 -> Pu-239, Th-232 -> Pa-233 -> U-233)
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

        // E. Cobalt-59 activation -> Cobalt-60 & Nitrogen-14 -> Carbon-14
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

        // F. Control rods & Xenon-135 poisoning
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

        // G. Probabilistic Moderators (steam excluded -> negative void coefficient!)
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

        // H. Reflectors & Beryllium (n, 2n) multiplication
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
        if (SHIELDING.has(tElem)) {
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
        if (tState === "gas" || tElem === "fire" || tElem === "plasma" || tElem === "radiation") {
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
  // 6. GRAVITY, BONDING & MAGNETISM ELEMENTS
  // ---------------------------------------------------------------------------

  // --- Gravity Elements ---
  registerOrEnhance("star_gravity", {
    color: ["#1a0b2e", "#31135e", "#4d1f91"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 99999,
    hardness: 1,
    desc: "Place anywhere on the canvas to enable global self-gravity! Gas clouds collapse into spherical stars, heat up via compression, fuse through Silicon to Iron, and go Supernova."
  });

  registerOrEnhance("gravity_well", {
    color: ["#120024", "#2a0052", "#5900a6"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 99999,
    hardness: 1,
    desc: "Localized planetary/stellar gravity anchor. Pulls surrounding matter radially inward and heats compressed cores."
  });

  registerOrEnhance("neutronium", {
    color: ["#d9f7ff", "#ffffff", "#9ce5ff"],
    behavior: behaviors.WALL,
    category: "astrophysics",
    state: "solid",
    density: 999999,
    hardness: 1,
    conduct: 1,
    desc: "Ultra-dense degenerate neutron-star matter forged during Supernova core collapse. Exerts extreme gravity and emits occasional fast neutrons.",
    tick: function (pixel) {
      if (Math.random() < 0.004) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      }
      doDefaults(pixel);
    }
  });

  // --- Bonding Tools ---
  registerOrEnhance("bond_catalyst", {
    color: ["#6bff7a", "#9cff9e", "#3de050"],
    behavior: behaviors.POWDER,
    category: "chemistry",
    state: "solid",
    density: 10,
    desc: "Drop onto any two adjacent elements to link them with a persistent chemical bond (keeping both pixels intact). Evaporates once the bond forms.",
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
    desc: "Cleaves all persistent chemical bonds on contact (auto-formed or catalyzed), then dissipates.",
    tick: function (pixel) {
      if (pixel.life === undefined) pixel.life = 25;
      pixel.life--;
      if (pixel.life <= 0) {
        deletePixel(pixel.x, pixel.y);
        return;
      }
      doDefaults(pixel);
    }
  });

  // --- Realistic North / South Magnets ---
  registerOrEnhance("magnet_north", {
    color: ["#d92626", "#e83838", "#bf1d1d"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 7500,
    conduct: 0.5,
    hardness: 0.8,
    tempHigh: 770, // Curie temperature!
    stateHigh: "iron",
    desc: "North magnetic pole (Curie temp: 770 C). Pulls ferromagnetic materials & South poles; repels North poles. Non-magnetic metals are unaffected.",
    tick: function (pixel) {
      applyMagneticField(pixel, 1, 10, 14);
      doDefaults(pixel);
    }
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
    desc: "South magnetic pole (Curie temp: 770 C). Pulls ferromagnetic materials & North poles; repels South poles. Demagnetizes to iron above 770 C.",
    tick: function (pixel) {
      applyMagneticField(pixel, -1, 10, 14);
      doDefaults(pixel);
    }
  });

  registerOrEnhance("neodymium_north", {
    color: ["#ff1744", "#ff4569", "#d5002f"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 7500,
    conduct: 0.45,
    hardness: 0.75,
    tempHigh: 310, // Real NdFeB Curie temp (~310 C)!
    stateHigh: "neodymium",
    desc: "High-strength Neodymium North pole (wider range, lower 310 C Curie point!). Pulls ferromagnetics & S poles; repels N poles.",
    tick: function (pixel) {
      applyMagneticField(pixel, 1, 15, 22);
      doDefaults(pixel);
    }
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
    desc: "High-strength Neodymium South pole (Curie temp: 310 C). Pulls ferromagnetics & N poles; repels S poles.",
    tick: function (pixel) {
      applyMagneticField(pixel, -1, 15, 22);
      doDefaults(pixel);
    }
  });

  registerOrEnhance("electromagnet_north", {
    color: ["#b85d38", "#cc6b43", "#9e4d2d"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 8400,
    conduct: 1,
    hardness: 0.8,
    desc: "Copper-wound Electromagnet (North pole). Inactive until electrified with shock/battery; generates a strong North field while powered.",
    tick: function (pixel) {
      if (pixel.charge && pixel.charge > 0) {
        applyMagneticField(pixel, 1, 14, 20);
      }
      doDefaults(pixel);
    }
  });

  registerOrEnhance("electromagnet_south", {
    color: ["#486b9e", "#587eb5", "#3b5985"],
    behavior: behaviors.WALL,
    category: "magnets",
    state: "solid",
    density: 8400,
    conduct: 1,
    hardness: 0.8,
    desc: "Copper-wound Electromagnet (South pole). Inactive until electrified; generates a strong South field while powered.",
    tick: function (pixel) {
      if (pixel.charge && pixel.charge > 0) {
        applyMagneticField(pixel, -1, 14, 20);
      }
      doDefaults(pixel);
    }
  });

  registerOrEnhance("magnet_bead_n", {
    color: ["#ff5252", "#ff7575"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 7400,
    tempHigh: 770,
    stateHigh: "iron_filings",
    desc: "Movable North-pole magnetic bead. Flies toward South poles and bounces away from North poles!",
    tick: function (pixel) {
      applyMagneticField(pixel, 1, 6, 6);
      doDefaults(pixel);
    }
  });

  registerOrEnhance("magnet_bead_s", {
    color: ["#448aff", "#69a1ff"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 7400,
    tempHigh: 770,
    stateHigh: "iron_filings",
    desc: "Movable South-pole magnetic bead. Flies toward North poles and bounces away from South poles!",
    tick: function (pixel) {
      applyMagneticField(pixel, -1, 6, 6);
      doDefaults(pixel);
    }
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
    desc: "Fine ferromagnetic iron powder. Pulled strongly by both North and South poles below 770 C; non-magnetic above its Curie point."
  });

  registerOrEnhance("superconductor", {
    color: ["#242933", "#303745", "#1c2029"],
    behavior: behaviors.POWDER,
    category: "magnets",
    state: "solid",
    density: 6300,
    conduct: 1,
    hardness: 0.7,
    desc: "YBCO High-Temp Superconductor. Cool below -180 C (e.g. liquid nitrogen) to activate the Meissner Effect—levitating above both North & South poles!",
    tick: function (pixel) {
      if (pixel.temp <= -180) {
        // Check nearby magnets and repel upward/outward (Meissner levitation)
        for (let dx = -5; dx <= 5; dx++) {
          for (let dy = -5; dy <= 5; dy++) {
            const nx = pixel.x + dx;
            const ny = pixel.y + dy;
            if (!inSafeBounds(nx, ny)) continue;
            const m = pixelMap[nx][ny];
            if (m && MAGNET_POLE_MAP[m.element] !== undefined) {
              if (Math.random() < 0.75) stepAway(pixel, m.x, m.y);
              return;
            }
          }
        }
      }
      doDefaults(pixel);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. NEUTRON PARTICLES & HEAVY WATER
  // ---------------------------------------------------------------------------

  registerOrEnhance("fast_neutron", {
    color: ["#ff4444", "#ff7744", "#ffaa44"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    temp: 20,
    desc: "Fast ~2 MeV neutron from fission, D-T fusion, or supernovae. Moderates in water/heavy water/graphite into thermal neutrons.",
    tick: function (pixel) {
      neutronTick(pixel, true);
    }
  });

  registerOrEnhance("thermal_neutron", {
    color: ["#44ccff", "#66eeff", "#99f5ff"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    temp: 20,
    desc: "Slow ~0.025 eV thermal neutron. High fission probability in U-235, Pu-239, U-233; absorbed by Boron, Cadmium, Hafnium, Xe-135.",
    tick: function (pixel) {
      neutronTick(pixel, false);
    }
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
      // High-temp thermolysis (>3,200 C) splits D2O back into Deuterium + Oxygen!
      if (pixel.temp >= 3200 && Math.random() < 0.20) {
        safeChange(pixel, Math.random() < 0.66 ? "deuterium" : "oxygen");
        return;
      }
      doDefaults(pixel);
    }
  });

  // ---------------------------------------------------------------------------
  // 8. FULL STELLAR FUSION ISOTOPES & INTERMEDIATES (H -> He -> C -> O -> Ne/Mg -> Si -> Ni-56 -> Fe)
  // ---------------------------------------------------------------------------

  // Deuterium (H-2)
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
      // D-T Fusion (10,000 C)
      if (pixel.temp >= 10000 && Math.random() < 0.55) {
        const t = findAdjacentElement(pixel, "tritium");
        if (t) {
          safeChange(pixel, "helium");
          safeChange(t, "fast_neutron");
          pixel.temp += 9000;
          t.temp += 9000;
          return;
        }
      }
      // D-D Fusion (25,000 C)
      if (pixel.temp >= 25000 && Math.random() < 0.35) {
        const other = findAdjacentElement(pixel, "deuterium");
        if (other) {
          if (Math.random() < 0.5) {
            safeChange(pixel, "tritium");
            safeChangeAny(other, ["proton", "hydrogen"]);
          } else {
            safeChange(pixel, "helium_3");
            safeChange(other, "fast_neutron");
          }
          pixel.temp += 4500;
          other.temp += 4500;
          return;
        }
      }
      // D-He3 Aneutronic Fusion (40,000 C)
      if (pixel.temp >= 40000 && Math.random() < 0.45) {
        const he3 = findAdjacentElement(pixel, "helium_3");
        if (he3) {
          safeChange(pixel, "helium");
          safeChangeAny(he3, ["proton", "hydrogen"]);
          pixel.temp += 11000;
          he3.temp += 11000;
          return;
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "heavy_steam", elem2: "fire", tempMin: 560, tempMax: 3000, chance: 0.65 }
    }
  });

  // Tritium (H-3)
  defineFullGas({
    id: "tritium",
    color: ["#5cffb0", "#82ffc4"],
    liquidColor: ["#28d483", "#3ee093"],
    solidColor: ["#9effd0", "#c4ffe2"],
    category: "isotopes",
    boilTemp: -248.1,
    meltTemp: -252.5,
    density: 0.27,
    desc: "Radioactive Hydrogen-3. Lowest-threshold fusion fuel with Deuterium (10,000 C); beta-decays into Helium-3.",
    tick: function (pixel) {
      if (Math.random() < 0.00015) {
        safeChange(pixel, "helium_3");
        pixel.temp += 5;
        return;
      }
      doDefaults(pixel);
    }
  });

  // Helium-3
  defineFullGas({
    id: "helium_3",
    color: ["#ffe0b3", "#ffd18c"],
    liquidColor: ["#f0b86e", "#e6a855"],
    solidColor: ["#fff0d9", "#ffe6bf"],
    category: "isotopes",
    boilTemp: -269.9,
    meltTemp: -272.2,
    density: 0.13,
    desc: "Light Helium-3 isotope. Aneutronic fusion with Deuterium (40,000 C) or He-3 + He-3 (45,000 C).",
    tick: function (pixel) {
      if (pixel.temp >= 45000 && Math.random() < 0.25) {
        const other = findAdjacentElement(pixel, "helium_3");
        if (other) {
          safeChange(pixel, "helium");
          safeChangeAny(other, ["proton", "hydrogen"]);
          pixel.temp += 7500;
          other.temp += 7500;
          return;
        }
      }
      doDefaults(pixel);
    }
  });

  // Elemental Carbon Vapor (fixes graphite -> CO2 bug + Carbon Burning -> Neon/Magnesium & C+He -> Oxygen!)
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
    desc: "Elemental Carbon-12 gas (>3,642 C). Fuses with Helium at 75,000 C -> Oxygen, or with Carbon at 82,000 C -> Neon / Magnesium.",
    tick: function (pixel) {
      // Alpha capture: C-12 + He-4 -> O-16 (75,000 C)
      if (pixel.temp >= 75000 && Math.random() < 0.18) {
        const he = findAdjacentElement(pixel, "helium");
        if (he) {
          safeChange(pixel, "oxygen");
          safeChange(he, "radiation");
          pixel.temp += 5000;
          return;
        }
      }
      // Carbon Burning: C-12 + C-12 -> Ne-20 or Mg-24 (82,000 C)
      if (pixel.temp >= 82000 && Math.random() < 0.15) {
        const other = findAdjacentElement(pixel, "carbon_vapor");
        if (other) {
          safeChange(pixel, Math.random() < 0.55 ? "neon" : "magnesium_gas");
          safeChange(other, "radiation");
          pixel.temp += 4500;
          return;
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.25 }
    }
  });

  // Carbon-14 (Radioactive tracer / atmospheric neutron capture on N-14)
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
    desc: "Radioactive Carbon-14 formed when thermal neutrons hit Nitrogen-14. Beta-decays slowly back into Nitrogen.",
    tick: function (pixel) {
      if (Math.random() < 0.0001) {
        safeChange(pixel, "nitrogen");
        return;
      }
      doDefaults(pixel);
    }
  });

  // Neon (Noble gas + Neon Burning -> Magnesium)
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
    desc: "Inert noble gas produced by Carbon burning in stars. Fuses with Helium at 88,000 C -> Magnesium.",
    tick: function (pixel) {
      if (pixel.temp >= 88000 && Math.random() < 0.16) {
        const he = findAdjacentElement(pixel, "helium");
        if (he) {
          safeChange(pixel, "magnesium_gas");
          safeChange(he, "radiation");
          pixel.temp += 4200;
          return;
        }
      }
      doDefaults(pixel);
    }
  });

  // Argon (Heavy inert shielding gas)
  defineFullGas({
    id: "argon",
    color: ["#c7b8ff", "#d6ccff"],
    liquidColor: ["#9b87f5", "#ac99ff"],
    solidColor: ["#e6e0ff", "#f0ecff"],
    category: "gases",
    boilTemp: -185.8,
    meltTemp: -189.3,
    density: 1.78,
    desc: "Dense, chemically inert noble gas. Sinks in air to blanket reactive metals like Cesium or Magnesium from oxygen."
  });

  // Magnesium (Reacts violently with oxygen/steam + Mg+He -> Silicon at 92,000 C!)
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
    desc: "Light reactive metal. Burns blindingly hot in oxygen (>470 C), reacts with steam, and fuses with Helium at 92,000 C into Silicon!",
    tick: function (pixel) {
      if (pixel.temp >= 92000 && Math.random() < 0.16) {
        const he = findAdjacentElement(pixel, "helium");
        if (he) {
          safeChange(pixel, "silicon_gas");
          safeChange(he, "radiation");
          pixel.temp += 4000;
          return;
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      oxygen: { elem1: "ash", elem2: "fire", tempMin: 470, tempMax: 3200, chance: 0.45, func: function (p1, p2) { p1.temp += 1800; } },
      steam:  { elem1: "ash", elem2: "hydrogen", tempMin: 300, chance: 0.35, func: function (p1, p2) { p1.temp += 900; } }
    }
  });

  // Silicon (Full Solid / Molten / Gas + Fusion -> Nickel-56 -> Iron!)
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
      // Silicon Burning (>=115,000 C): Si + He (or Si + Si) -> Nickel-56!
      if (pixel.temp >= 115000 && Math.random() < 0.16) {
        const partner = findAdjacentElement(pixel, "helium") || findAdjacentElement(pixel, SILICON_STATES);
        if (partner) {
          safeChange(pixel, "nickel_56_gas");
          safeChange(partner, "radiation");
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

  // Nickel-56 -> Cobalt-56 -> Iron-56 (Real Supernova radioactive decay chain!)
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
    desc: "Radioactive Nickel-56 forged by Silicon burning in stars. Decays with intense heat into Cobalt-56 -> Iron-56 (powering supernova light curves!).",
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
    desc: "Intermediate supernova decay isotope (from Nickel-56). Decays into stable Iron-56.",
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
  // 9. FISSILE, FERTILE & FISSION-PRODUCT ISOTOPES
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
    desc: "Fertile U-238. Absorbs neutrons to breed Neptunium-239 -> Plutonium-239."
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
    desc: "Fissile Plutonium-239. High fast-neutron fission cross-section; self-heats via alpha decay.",
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
    desc: "Thorium breeder intermediate. Decays into Uranium-233.",
    tick: function (pixel) {
      pixel.temp += 0.06;
      if (Math.random() < 0.002) {
        safeChange(pixel, "uranium_233");
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

  defineFullGas({
    id: "xenon_135",
    color: ["#9a78e3", "#b091f2"],
    liquidColor: ["#6c47bd", "#7d55d1"],
    solidColor: ["#c6b3f5", "#d8c9fa"],
    category: "isotopes",
    boilTemp: -108.1,
    meltTemp: -111.8,
    density: 5.89,
    desc: "Extreme thermal neutron absorber (reactor poison). Burns to Xe-136 or decays to Cs-135.",
    tick: function (pixel) {
      if (Math.random() < 0.0012) { safeChange(pixel, "cesium_135"); return; }
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
      if (Math.random() < 0.0015) spawnNeutronsAround(pixel.x, pixel.y, 1, "thermal_neutron");
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
      if (Math.random() < 0.0008) spawnNeutronsAround(pixel.x, pixel.y, 1, "thermal_neutron");
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
    desc: "Long-lived fission daughter (RTG heat source).",
    tick: function (pixel) { pixel.temp += 0.08; doDefaults(pixel); }
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
  // 10. REACTOR, MAGNETIC & EXOTIC CHEMICAL ELEMENTS (FULL STATE CHAINS)
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
    desc: "Crystalline carbon moderator. Sublimates into carbon_vapor at 3,642 C; reduces sand to molten_silicon (>1,900 C).",
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.15 },
      sand:   { elem1: "carbon_dioxide", elem2: "molten_silicon", tempMin: 1900, tempMax: 3500, chance: 0.22 }
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
    desc: "Neutron reflector & (n, 2n) multiplier. Touch Polonium-210 to build a real neutron initiator.",
    reactions: {
      polonium_210: {
        chance: 0.08,
        func: function (p1, p2) { spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron"); p1.temp += 15; }
      }
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
    desc: "Control-rod thermal neutron absorber."
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
    desc: "Refractory submarine-reactor control rod absorber. Withstands extreme temperatures."
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
    desc: "Fusion blanket breeder: absorbs neutrons -> Tritium + Helium-4.",
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
    desc: "Ferromagnetic metal (Curie temp: 358 C). Pulled by magnets below 358 C."
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
    desc: "Intense gamma-emitting Cobalt-60.",
    tick: function (pixel) {
      pixel.temp += 0.25;
      if (Math.random() < 0.015) {
        const d = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        safeCreate("radiation", pixel.x + d[0], pixel.y + d[1]);
      }
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
    desc: "Rare-earth magnetic metal (Curie temp: 310 C). Demagnetized form of Neodymium magnets."
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
    desc: "Magnetic thermal switch! Ferromagnetic (pulled by magnets) below 20 C, non-magnetic above 20 C!"
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
    desc: "Precious noble metal catalyst. Catalyzes room-temp H2+O2 ignition and Haber-process Ammonia synthesis (N2+H2 at 400-600 C).",
    tick: function (pixel) {
      // Catalytic H2 + O2 ignition & Haber process (N2 + H2 -> Ammonia)
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
    id: "polonium_210",
    color: ["#8c9e99", "#9eb0ab"],
    moltenColor: ["#b5f5d8", "#ccffe8"],
    gasColor: ["#a8bfb9", "#bcd4ce"],
    category: "isotopes",
    meltTemp: 254,
    boilTemp: 962,
    density: 9196,
    conduct: 0.5,
    desc: "Intense alpha emitter (~140 W/g). Place next to Beryllium for a neutron gun.",
    tick: function (pixel) {
      pixel.temp += 0.45;
      if (Math.random() < 0.01) {
        const d = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        safeCreate("radiation", pixel.x + d[0], pixel.y + d[1]);
      }
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
      if (Math.random() < 0.0005) { safeChange(pixel, "polonium_210"); pixel.temp += 20; return; }
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
    desc: "Melts at 28.5 C; detonates violently with water/ice. Store under Argon!",
    reactions: {
      water: { chance: 0.9, func: function (p1) { safeChange(p1, "hydrogen"); p1.temp += 1200; explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } },
      ice:   { chance: 0.7, func: function (p1) { safeChange(p1, "hydrogen"); explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam"); } },
      oxygen:{ elem1: "fire", elem2: "ash", tempMin: 35, chance: 0.35 }
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
    desc: "Pyrophoric White Phosphorus. Auto-ignites in oxygen above 30 C! Store underwater or in Argon.",
    reactions: {
      oxygen: { elem1: "fire", elem2: "smoke", tempMin: 30, chance: 0.5, func: function (p1) { p1.temp += 800; } }
    }
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
    desc: "Densest naturally occurring element on Earth (22,590 kg/m^3)."
  });

  // ---------------------------------------------------------------------------
  // 11. PATCH VANILLA & CHEM.JS + HOOK GRAVITY, BONDS & RENDERING
  // ---------------------------------------------------------------------------

  runAfterLoad(function () {
    // 1. Ensure iron_gas exists for hot stellar cores
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
      elements.neutron.desc = "Free neutron (enhanced by Unified Physics & Chemistry).";
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
    // Hydrogen p-p fusion (50,000 C) -> Deuterium
    if (elements.hydrogen) {
      wrapTick("hydrogen", function (pixel) {
        if (pixel.temp >= 50000 && Math.random() < 0.16) {
          const other = findAdjacentElement(pixel, "hydrogen");
          if (other) {
            safeChange(pixel, "deuterium");
            safeChangeAny(other, ["positron", "radiation"]);
            pixel.temp += 4000;
            other.temp += 4000;
            return true;
          }
        }
        return false;
      });
    }

    // Helium Triple-Alpha fusion (65,000 C) -> carbon_vapor (NOT CO2!)
    if (elements.helium) {
      wrapTick("helium", function (pixel) {
        if (pixel.temp >= 65000 && Math.random() < 0.15) {
          const other = findAdjacentElement(pixel, "helium");
          if (other) {
            safeChange(pixel, "carbon_vapor");
            safeChange(other, "radiation");
            pixel.temp += 5500;
            other.temp += 5500;
            return true;
          }
        }
        return false;
      });
    }

    // Oxygen Burning (95,000 C) -> silicon_gas (75%) or sulfur (25%)!
    if (elements.oxygen) {
      wrapTick("oxygen", function (pixel) {
        if (pixel.temp >= 95000 && Math.random() < 0.16) {
          const other = findAdjacentElement(pixel, "oxygen");
          if (other) {
            if (Math.random() < 0.75) {
              safeChange(pixel, "silicon_gas");
            } else {
              safeChangeAny(pixel, ["sulfur_gas", "molten_sulfur", "sulfur", "silicon_gas"]);
            }
            safeChange(other, "radiation");
            pixel.temp += 4000;
            other.temp += 4000;
            return true;
          }
        }
        return false;
      });
    }

    // 4. High-Temperature Thermal Dissociation (CO2, Steam, Ammonia)
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

    // 5. Integrate with chem.js uranium_dioxide if loaded
    if (elements.uranium_dioxide) {
      FISSILE_SPECS.uranium_dioxide = {
        thermalProb: 0.45,
        fastProb: 0.04,
        neutrons: [2, 3],
        heat: 1850,
        daughters: ["barium_141", "krypton_92", "xenon_135"]
      };
    }

    // 6. Hook global simulation tick for Gravity/Compression & Bond Engine
    if (typeof window !== "undefined" && typeof window.tickPixels === "function") {
      const origTickPixels = window.tickPixels;
      window.tickPixels = function (...args) {
        const res = origTickPixels.apply(this, args);
        try {
          updateGravityAndCompressionTick();
          updateBondsTick();
        } catch (err) {
          console.error("[unified_physics_chem] global tick error:", err);
        }
        return res;
      };
    }

    // 7. Hook canvas render to draw visible chemical bond lines between linked pixels
    if (typeof window !== "undefined" && typeof window.drawPixels === "function") {
      const origDrawPixels = window.drawPixels;
      window.drawPixels = function (...args) {
        const res = origDrawPixels.apply(this, args);
        try {
          drawActiveBonds();
        } catch (err) {}
        return res;
      };
    }

    // 8. Global safety sweep across all loaded elements (vanilla + chem.js + this mod)
    for (const key in elements) {
      const el = elements[key];
      if (!el) continue;
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
  });
})();
