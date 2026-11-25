/*
 * Nuclear & Chemistry Plus v2 (nuclear_chem_plus.js)
 * Add-on for Sandboxels + chem.js
 * - Crash-proof neutron transport, moderation, delayed neutrons, Doppler feedback, Xenon poisoning
 * - Full stellar & terrestrial fusion ladder (D-T, D-D, D-He3, He3-He3, p-p, Triple-Alpha, C+He->O, O+O->Si, Si+He->Fe)
 * - Accurate carbon sublimation (graphite <-> carbon_vapor) & CO2 thermal dissociation (>4000 C)
 * - Full solid / molten / gas state chains for isotopes & missing elements
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. HELPER UTILITIES
  // ---------------------------------------------------------------------------

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
      if (extraFn(pixel) === true) return; // handled & transmuted
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
      viscosity: 15,
      reactions: Object.assign({}, reactions)
    };
    if (hasTick) moltenDef.tick = tick;
    registerOrEnhance(moltenId, moltenDef);

    registerOrEnhance(gasId, {
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
    });
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
  // 2. NUCLEAR PHYSICS ENGINE (CRASH-PROOF NEUTRON TRANSPORT & FISSION)
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
  const POISONS = new Set(["boron", "molten_boron", "cadmium", "molten_cadmium", "xenon_135", "hafnium"]);
  const SHIELDING = new Set(["lead", "molten_lead", "concrete", "osmium"]);

  const NON_ZERO_DIRS = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1]
  ];

  // Performance & runaway safeguards
  const MAX_NEUTRONS = 300;
  const MAX_SPAWN_PER_TICK = 35;
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

  function randomDir() {
    return NON_ZERO_DIRS[Math.floor(Math.random() * NON_ZERO_DIRS.length)];
  }

  function inSafeBounds(x, y) {
    return !outOfBounds(x, y) && pixelMap[x] !== undefined;
  }

  function safeChange(pixel, elemName) {
    if (!pixel || pixel.del) return false;
    if (!elements[elemName]) {
      if (inSafeBounds(pixel.x, pixel.y)) deletePixel(pixel.x, pixel.y);
      return false;
    }
    changePixel(pixel, elemName);
    return true;
  }

  function safeSwap(p1, p2) {
    if (!p1 || !p2 || p1 === p2 || p1.del || p2.del) return;
    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    if (!inSafeBounds(x1, y1) || !inSafeBounds(x2, y2)) return;
    p1.x = x2; p1.y = y2;
    p2.x = x1; p2.y = y1;
    pixelMap[x1][y1] = p2;
    pixelMap[x2][y2] = p1;
  }

  function findAdjacentElement(pixel, targetName) {
    const start = Math.floor(Math.random() * adjacentCoords.length);
    for (let i = 0; i < adjacentCoords.length; i++) {
      const idx = (start + i) % adjacentCoords.length;
      const nx = pixel.x + adjacentCoords[idx][0];
      const ny = pixel.y + adjacentCoords[idx][1];
      if (!inSafeBounds(nx, ny)) continue;
      const other = pixelMap[nx][ny];
      if (other && !other.del && other.element === targetName) return other;
    }
    return null;
  }

  const FISSILE_SPECS = {
    uranium_235:        { thermalProb: 0.78, fastProb: 0.08, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    molten_uranium_235: { thermalProb: 0.72, fastProb: 0.07, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    plutonium_239:      { thermalProb: 0.82, fastProb: 0.24, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    molten_plutonium_239:{ thermalProb: 0.78, fastProb: 0.22, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    uranium_233:        { thermalProb: 0.80, fastProb: 0.14, neutrons: [2, 3], heat: 2300, daughters: ["barium_141", "krypton_92", "strontium_90"] },
    molten_uranium_233: { thermalProb: 0.75, fastProb: 0.12, neutrons: [2, 3], heat: 2300, daughters: ["barium_141", "krypton_92", "strontium_90"] },
    uranium:            { thermalProb: 0.35, fastProb: 0.03, neutrons: [2, 2], heat: 1600, daughters: ["barium_141", "krypton_92", "xenon_135"] },
    plutonium:          { thermalProb: 0.82, fastProb: 0.24, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90"] },
    enriched_uranium:   { thermalProb: 0.76, fastProb: 0.08, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] }
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
    for (const [dx, dy] of dirs) {
      if (spawned >= count) break;
      if (prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS || spawnedThisTick >= MAX_SPAWN_PER_TICK) break;
      for (let dist = 1; dist <= 2; dist++) {
        const nx = cx + dx * dist;
        const ny = cy + dy * dist;
        if (!inSafeBounds(nx, ny)) break;
        if (isEmpty(nx, ny)) {
          createPixel(type, nx, ny);
          const np = pixelMap[nx][ny];
          if (np) {
            np.vx = dx;
            np.vy = dy;
            np.life = 90;
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
      if (pixel.life === undefined) pixel.life = 90;
      pixel.life--;

      if (pixel.life <= 0) {
        safeChange(pixel, "proton");
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

        // A. Fission (with subtle Doppler broadening at high temp for thermal neutrons)
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
            if (Math.random() < 0.5) {
              safeSwap(pixel, target);
            } else {
              pixel.vx = -pixel.vx;
              pixel.vy = -pixel.vy;
            }
            return;
          }
        }

        // B. Fertile breeding (U-238 resonance capture rises slightly with temp)
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

        // C. Tritium breeding blanket (Li-6 + n -> T + He-4)
        if (tElem === "lithium_6" || tElem === "molten_lithium_6") {
          if (Math.random() < 0.55) {
            safeChange(target, "tritium");
            target.temp += 850;
            safeChange(pixel, "helium");
            return;
          }
        }

        // D. Cobalt-59 neutron activation -> Cobalt-60
        if (tElem === "cobalt" || tElem === "molten_cobalt") {
          if (Math.random() < 0.30) {
            safeChange(target, "cobalt_60");
            target.temp += 120;
            deletePixel(pixel.x, pixel.y);
            return;
          }
        }

        // E. Control rods & reactor poisons
        if (POISONS.has(tElem)) {
          const absorbProb = tElem === "xenon_135" ? 0.96 : 0.85;
          if (!isFast && Math.random() < absorbProb) {
            target.temp += 80;
            if (tElem === "boron" && Math.random() < 0.15) {
              safeChange(target, "lithium_7");
            } else if (tElem === "xenon_135") {
              safeChange(target, "xenon_136");
            }
            deletePixel(pixel.x, pixel.y);
            return;
          }
        }

        // F. Probabilistic Moderators (steam is excluded -> natural negative void coefficient in water reactors!)
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

        // G. Neutron Reflectors (Beryllium, Tungsten, Steel)
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

        // H. High-Z Shielding
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

        // I. Pass through gases, plasma, fire, radiation, or other neutrons
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
        console.error("[nuclear_chem_plus] neutronTick error:", err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. NEUTRON PARTICLES
  // ---------------------------------------------------------------------------

  elements.fast_neutron = {
    color: ["#ff4444", "#ff7744", "#ffaa44"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    temp: 20,
    reactions: {},
    desc: "High-energy (~2 MeV) neutron emitted by fission or D-T fusion. Moderates in water, heavy water, or graphite into a thermal neutron.",
    tick: function (pixel) {
      neutronTick(pixel, true);
    }
  };

  elements.thermal_neutron = {
    color: ["#44ccff", "#66eeff", "#99f5ff"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "gas",
    density: 0.01,
    temp: 20,
    reactions: {},
    desc: "Moderated slow neutron (~0.025 eV). High fission cross-section for U-235, Pu-239, U-233; absorbed by Boron, Cadmium, and Xe-135.",
    tick: function (pixel) {
      neutronTick(pixel, false);
    }
  };

  // ---------------------------------------------------------------------------
  // 4. HYDROGEN, HELIUM & CARBON VAPOR (ACCURATE FUSION)
  // ---------------------------------------------------------------------------

  // Elemental Carbon Vapor (fixes graphite -> CO2 bug!)
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
    desc: "Elemental carbon gas (C-12) produced by Triple-Alpha fusion or graphite sublimation (>3,642 C). Fuses with Helium at 75,000 C to form Oxygen-16.",
    reactions: {
      // Alpha capture: C-12 + He-4 -> O-16 + gamma
      helium: {
        elem1: "oxygen",
        elem2: "radiation",
        tempMin: 75000,
        chance: 0.16,
        func: function (p1, p2) {
          p1.temp += 5000;
        }
      },
      // Only forms CO2 in combustion range (not plasma temperatures)
      oxygen: {
        elem1: "carbon_dioxide",
        elem2: "fire",
        tempMin: 750,
        tempMax: 3500,
        chance: 0.25
      }
    }
  });

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
    desc: "Hydrogen-2. Fuses with Tritium (10,000 C), Deuterium (25,000 C), or Helium-3 (40,000 C). Burns in oxygen to form heavy water.",
    tick: function (pixel) {
      // D-D Fusion in tick (avoids Sandboxels's stale otherInfo double-reactPixels crash)
      if (pixel.temp >= 25000 && Math.random() < 0.35) {
        const other = findAdjacentElement(pixel, "deuterium");
        if (other) {
          if (Math.random() < 0.5) {
            safeChange(pixel, "tritium");
            safeChange(other, "proton");
          } else {
            safeChange(pixel, "helium_3");
            safeChange(other, "fast_neutron");
          }
          pixel.temp += 4500;
          other.temp += 4500;
          return;
        }
      }
      doDefaults(pixel);
    },
    reactions: {
      tritium: {
        elem1: "helium",
        elem2: "fast_neutron",
        tempMin: 10000,
        chance: 0.65,
        func: function (p1, p2) {
          p1.temp += 9000;
          p2.temp += 9000;
        }
      },
      helium_3: {
        elem1: "helium",
        elem2: "proton",
        tempMin: 40000,
        chance: 0.55,
        func: function (p1, p2) {
          p1.temp += 11000;
          p2.temp += 11000;
        }
      },
      oxygen: {
        elem1: "heavy_steam",
        elem2: "fire",
        tempMin: 560,
        tempMax: 3500,
        chance: 0.7
      }
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
    desc: "Radioactive Hydrogen-3. Fuses with Deuterium at 10,000 C; beta-decays slowly into Helium-3.",
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
    desc: "Light Helium isotope. Aneutronic fusion with Deuterium (40,000 C) or He-3 + He-3 (45,000 C).",
    tick: function (pixel) {
      // He-3 + He-3 -> He-4 + 2p (modeled as helium + proton)
      if (pixel.temp >= 45000 && Math.random() < 0.25) {
        const other = findAdjacentElement(pixel, "helium_3");
        if (other) {
          safeChange(pixel, "helium");
          safeChange(other, "proton");
          pixel.temp += 7500;
          other.temp += 7500;
          return;
        }
      }
      doDefaults(pixel);
    }
  });

  // Heavy Water (D2O) + Heavy Ice + Heavy Steam
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
    desc: "Deuterium Oxide (D2O). Moderates fast neutrons without absorbing them, allowing natural uranium to go critical."
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
    stateLow: "heavy_water"
  });

  // ---------------------------------------------------------------------------
  // 5. FISSILE, FERTILE & DECAY ISOTOPES
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
    desc: "Fissile Uranium-235. Captures thermal neutrons to release ~200 MeV heat, 2-3 fast neutrons, and fission daughters.",
    tick: function (pixel) {
      if (Math.random() < 0.00025) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      }
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
    desc: "Fertile Depleted Uranium (U-238). Absorbs neutrons to breed Neptunium-239 -> Plutonium-239."
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
    desc: "Short-lived isotope bred from U-238 + n. Beta-decays into Plutonium-239.",
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
    desc: "Fissile Plutonium-239. High fast-neutron cross-section; self-heats via alpha decay.",
    tick: function (pixel) {
      pixel.temp += 0.05;
      if (Math.random() < 0.0006) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      }
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
    desc: "Fertile Thorium-232. Captures neutrons to breed Protactinium-233 -> fissile Uranium-233."
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
    desc: "Intermediate Thorium breeder isotope. Beta-decays into fissile Uranium-233.",
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

  // ---------------------------------------------------------------------------
  // 6. FISSION PRODUCTS & REACTOR POISONS (WITH DELAYED NEUTRONS)
  // ---------------------------------------------------------------------------

  defineFullGas({
    id: "xenon_135",
    color: ["#9a78e3", "#b091f2"],
    liquidColor: ["#6c47bd", "#7d55d1"],
    solidColor: ["#c6b3f5", "#d8c9fa"],
    category: "isotopes",
    boilTemp: -108.1,
    meltTemp: -111.8,
    density: 5.89,
    desc: "Notorious reactor poison with huge thermal neutron capture cross-section. Decays into Cesium-135.",
    tick: function (pixel) {
      if (Math.random() < 0.0012) {
        safeChange(pixel, "cesium_135");
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
    desc: "Stable Xenon isotope formed when Xenon-135 burns off by capturing a neutron."
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
    desc: "Short-lived fission gas. Emits decay heat and occasional delayed neutrons before decaying to Strontium-90.",
    tick: function (pixel) {
      pixel.temp += 0.15;
      if (Math.random() < 0.0015) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "thermal_neutron");
      }
      if (Math.random() < 0.004) {
        safeChange(pixel, "strontium_90");
        return;
      }
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
    desc: "Radioactive fission product. Produces decay heat and occasional delayed neutrons.",
    tick: function (pixel) {
      pixel.temp += 0.12;
      if (Math.random() < 0.0008) {
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
    desc: "Long-lived fission product (used in RTGs). Steady decay heat.",
    tick: function (pixel) {
      pixel.temp += 0.08;
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
    desc: "Long-lived radioactive Cesium isotope from Xenon-135 decay."
  });

  // ---------------------------------------------------------------------------
  // 7. REACTOR ENGINEERING MATERIALS & EXOTIC ELEMENTS
  // ---------------------------------------------------------------------------

  // Graphite (Moderator) -> Sublimates to carbon_vapor, NOT carbon_dioxide!
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
    desc: "Crystalline carbon neutron moderator. Sublimates into carbon vapor at 3,642 C; burns in oxygen between 750 C and 3,500 C.",
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, tempMax: 3500, chance: 0.15 }
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
    desc: "Light metal that reflects and multiplies fast neutrons via (n, 2n). Pair with Polonium-210 for a neutron initiator.",
    reactions: {
      polonium_210: {
        chance: 0.08,
        func: function (p1, p2) {
          spawnNeutronsAround(p1.x, p1.y, 1, "fast_neutron");
          p1.temp += 15;
        }
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
    desc: "Hard metalloid control-rod absorber. Captures thermal neutrons to throttle or SCRAM a fission reactor."
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
    desc: "Soft metal with a huge thermal neutron capture cross-section. Classic control-rod material."
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
    desc: "Lithium-6 isotope. Absorbs neutrons to breed Tritium + Helium-4 for fusion blankets.",
    reactions: {
      water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: function (p1, p2) { p1.temp += 300; } }
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
    desc: "Most abundant Lithium isotope. Low neutron absorption; used in molten-salt coolants.",
    reactions: {
      water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: function (p1, p2) { p1.temp += 300; } }
    }
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
    desc: "Ferromagnetic metal. Absorbs neutrons to become intensely radioactive Cobalt-60."
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
    desc: "Neutron-activated Cobalt-60. Emits intense gamma radiation and self-heats.",
    tick: function (pixel) {
      pixel.temp += 0.25;
      if (Math.random() < 0.015) {
        const d = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        const nx = pixel.x + d[0];
        const ny = pixel.y + d[1];
        if (inSafeBounds(nx, ny) && isEmpty(nx, ny)) {
          createPixel("radiation", nx, ny);
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
    desc: "Intense alpha emitter (~140 W/g decay heat). Place touching Beryllium to build a neutron initiator.",
    tick: function (pixel) {
      pixel.temp += 0.45;
      if (Math.random() < 0.01) {
        const d = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        const nx = pixel.x + d[0];
        const ny = pixel.y + d[1];
        if (inSafeBounds(nx, ny) && isEmpty(nx, ny)) {
          createPixel("radiation", nx, ny);
        }
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
    desc: "Dense radioactive noble gas. Sinks in air, glows orange-yellow when frozen, decays into Polonium-210.",
    tick: function (pixel) {
      if (Math.random() < 0.0005) {
        safeChange(pixel, "polonium_210");
        pixel.temp += 20;
        return;
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
    desc: "Alkali metal that melts at 28.5 C and detonates violently on contact with water or ice.",
    reactions: {
      water: {
        chance: 0.9,
        func: function (p1, p2) {
          safeChange(p1, "hydrogen");
          p1.temp += 1200;
          explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam");
        }
      },
      ice: {
        chance: 0.7,
        func: function (p1, p2) {
          safeChange(p1, "hydrogen");
          explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam");
        }
      },
      oxygen: { elem1: "fire", elem2: "ash", tempMin: 40, chance: 0.35 }
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
    desc: "Soft alkali metal (melts at 39.3 C). Reacts explosively with water.",
    reactions: {
      water: {
        chance: 0.85,
        func: function (p1, p2) {
          safeChange(p1, "hydrogen");
          explodeAt(p1.x, p1.y, 3, "fire,hydrogen,steam");
        }
      }
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
      aluminum: { elem2: "metal_scrap", chance: 0.18 }
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
    desc: "Densest natural element on Earth (22,590 kg/m^3)."
  });

  // ---------------------------------------------------------------------------
  // 8. PATCH VANILLA & CHEM.JS ELEMENTS AFTER LOAD
  // ---------------------------------------------------------------------------

  runAfterLoad(function () {
    // 1. Patch vanilla neutron
    if (elements.neutron) {
      elements.neutron.desc = "Free neutron (enhanced by Nuclear & Chemistry Plus v2).";
      if (!elements.neutron.reactions) elements.neutron.reactions = {};
      elements.neutron.tick = function (pixel) {
        neutronTick(pixel, true);
      };
    }

    // 2. Patch vanilla Uranium & Plutonium
    if (elements.uranium) {
      elements.uranium.desc = "Natural/Low-Enriched Uranium (patched). Requires moderated thermal neutrons for sustained fission.";
      elements.uranium.tick = function (pixel) {
        if (Math.random() < 0.0001) {
          spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        }
        doDefaults(pixel);
      };
    }

    if (elements.plutonium) {
      elements.plutonium.desc = "Plutonium-239 (patched). Self-heats via alpha decay; fissions on thermal and fast neutrons.";
      elements.plutonium.tick = function (pixel) {
        pixel.temp += 0.05;
        if (Math.random() < 0.0005) {
          spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        }
        doDefaults(pixel);
      };
    }

    // 3. Hydrogen p-p fusion (50,000 C) safely in tick
    if (elements.hydrogen) {
      wrapTick("hydrogen", function (pixel) {
        if (pixel.temp >= 50000 && Math.random() < 0.15) {
          const other = findAdjacentElement(pixel, "hydrogen");
          if (other) {
            safeChange(pixel, "deuterium");
            safeChange(other, elements.positron ? "positron" : "radiation");
            pixel.temp += 4000;
            other.temp += 4000;
            return true;
          }
        }
        return false;
      });
    }

    // 4. Helium Triple-Alpha fusion (65,000 C) -> carbon_vapor (NOT CO2!) safely in tick
    if (elements.helium) {
      wrapTick("helium", function (pixel) {
        if (pixel.temp >= 65000 && Math.random() < 0.14) {
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

    // 5. Oxygen Burning (95,000 C) -> Silicon (or molten_glass fallback) safely in tick
    if (elements.oxygen) {
      const siTarget = elements.silicon ? "silicon" : (elements.molten_glass ? "molten_glass" : "sand");
      wrapTick("oxygen", function (pixel) {
        if (pixel.temp >= 95000 && Math.random() < 0.12) {
          const other = findAdjacentElement(pixel, "oxygen");
          if (other) {
            safeChange(pixel, siTarget);
            safeChange(other, "radiation");
            pixel.temp += 4000;
            other.temp += 4000;
            return true;
          }
        }
        return false;
      });
    }

    // 6. Silicon Burning (120,000 C) -> Iron-56 (end of exothermic stellar fusion!)
    const siElem = elements.silicon ? "silicon" : null;
    if (siElem) {
      safeAddReaction(siElem, "helium", {
        elem1: elements.molten_iron ? "molten_iron" : "iron",
        elem2: "radiation",
        tempMin: 120000,
        chance: 0.10,
        func: function (p1, p2) {
          p1.temp += 2500;
        }
      });
    }

    // 7. Thermal dissociation of CO2 above 4,000 C -> carbon_vapor + oxygen
    if (elements.carbon_dioxide) {
      wrapTick("carbon_dioxide", function (pixel) {
        if (pixel.temp >= 4000 && Math.random() < 0.25) {
          safeChange(pixel, Math.random() < 0.5 ? "carbon_vapor" : "oxygen");
          return true;
        }
        return false;
      });
    }

    // 8. Molten Gallium embrittles Aluminum
    if (elements.molten_gallium && elements.aluminum) {
      safeAddReaction("molten_gallium", "aluminum", {
        elem2: "metal_scrap",
        chance: 0.35
      });
    }

    // 9. Integrate with chem.js uranium_dioxide if loaded
    if (elements.uranium_dioxide) {
      FISSILE_SPECS.uranium_dioxide = {
        thermalProb: 0.45,
        fastProb: 0.04,
        neutrons: [2, 3],
        heat: 1850,
        daughters: ["barium_141", "krypton_92", "xenon_135"]
      };
    }

    // 10. Global safety sweep: strip any non-function tick & guarantee behavior
    for (const key in elements) {
      const el = elements[key];
      if (!el) continue;
      if (el.tick !== undefined && typeof el.tick !== "function") {
        delete el.tick;
      }
      if (!el.behavior && !el.tick) {
        el.behavior = el.state === "liquid" ? behaviors.LIQUID
          : el.state === "gas" ? behaviors.GAS
          : behaviors.WALL;
      }
    }
  });
})();
