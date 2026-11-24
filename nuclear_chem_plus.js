/*
 * Nuclear & Chemistry Plus (nuclear_chem_plus.js)
 * Add-on for Sandboxels + chem.js
 * Features:
 *  - Accurate neutron-mediated fission (fast vs. thermal neutrons, moderation, control rods, reflectors, Xenon poisoning)
 *  - Breeder fuel cycles (U-238 -> Np-239 -> Pu-239, Th-232 -> Pa-233 -> U-233)
 *  - Accurate nuclear fusion (D-T, D-D, D-He3, Triple-Alpha, Li-6 tritium breeding)
 *  - Full solid / molten / gas state chains for isotopes & missing elements
 *  - Real-world chemistry (Cs/Rb water explosions, Gallium aluminum embrittlement, Po-Be neutron initiators)
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

  function registerOrEnhance(name, def) {
    if (elements[name]) {
      const existing = elements[name];
      if (def.reactions) {
        existing.reactions = Object.assign({}, existing.reactions || {}, def.reactions);
      }
      // Preserve existing chem.js properties unless explicitly overriding physics
      for (const key of Object.keys(def)) {
        if (key === "reactions") continue;
        if (existing[key] === undefined || def._override) {
          existing[key] = def[key];
        }
      }
    } else {
      const clean = Object.assign({}, def);
      delete clean._override;
      elements[name] = clean;
    }
  }

  /**
   * Registers a full Solid -> Molten -> Gas state chain for a metal/solid element.
   */
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
      tick = null,
      desc = "",
      extra = {}
    } = cfg;

    const moltenId = "molten_" + id;
    const gasId = id + "_gas";

    registerOrEnhance(id, Object.assign({
      color,
      behavior,
      category,
      state: "solid",
      density,
      conduct,
      hardness,
      tempHigh: meltTemp,
      stateHigh: moltenId,
      reactions,
      tick,
      desc
    }, extra));

    registerOrEnhance(moltenId, {
      color: moltenColor || ["#ff7b29", "#ff9e3d", "#ffb84d"],
      behavior: behaviors.MOLTEN,
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
      reactions,
      tick
    });

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
      reactions
    });
  }

  /**
   * Registers a full Gas -> Liquid -> Solid state chain for a gas/isotope.
   */
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
      tick = null,
      desc = "",
      extra = {}
    } = cfg;

    const liquidId = "liquid_" + id;
    const solidId = "solid_" + id;

    registerOrEnhance(id, Object.assign({
      color,
      behavior: behaviors.GAS,
      category,
      state: "gas",
      density,
      tempLow: boilTemp,
      stateLow: liquidId,
      reactions,
      tick,
      desc
    }, extra));

    registerOrEnhance(liquidId, {
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
      reactions,
      tick
    });

    registerOrEnhance(solidId, {
      color: solidColor || liquidColor || color,
      behavior: behaviors.WALL,
      category: "states",
      state: "solid",
      hidden: true,
      density: Math.max(80, Math.round(density * 750)),
      temp: meltTemp - 5,
      tempHigh: meltTemp,
      stateHigh: liquidId,
      reactions,
      tick
    });
  }

  // ---------------------------------------------------------------------------
  // 2. NUCLEAR PHYSICS ENGINE (NEUTRON TRANSPORT, FISSION & CRITICALITY)
  // ---------------------------------------------------------------------------

  const MODERATORS = new Set(["heavy_water", "water", "graphite", "ice", "heavy_ice", "paraffin"]);
  const REFLECTORS = new Set(["beryllium", "molten_beryllium", "tungsten", "steel"]);
  const POISONS = new Set(["boron", "molten_boron", "cadmium", "molten_cadmium", "xenon_135", "hafnium"]);
  const SHIELDING = new Set(["lead", "molten_lead", "concrete", "osmium"]);

  // Performance & runaway safeguards (prevents Demon Core freeze)
  const MAX_NEUTRONS = 300;
  const MAX_SPAWN_PER_TICK = 35;
  const EXPLODE_COOLDOWN_TICKS = 8;

  let lastPhysicsTick = -1;
  let neutronsThisTick = 0;
  let prevTickNeutrons = 0;
  let spawnedThisTick = 0;
  let lastExplodeTick = -100;

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
    uranium_235: { thermalProb: 0.78, fastProb: 0.08, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    molten_uranium_235: { thermalProb: 0.72, fastProb: 0.07, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] },
    plutonium_239: { thermalProb: 0.82, fastProb: 0.22, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    molten_plutonium_239: { thermalProb: 0.78, fastProb: 0.20, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90", "cesium_135"] },
    uranium_233: { thermalProb: 0.80, fastProb: 0.14, neutrons: [2, 3], heat: 2300, daughters: ["barium_141", "krypton_92", "strontium_90"] },
    molten_uranium_233: { thermalProb: 0.75, fastProb: 0.12, neutrons: [2, 3], heat: 2300, daughters: ["barium_141", "krypton_92", "strontium_90"] },
    uranium: { thermalProb: 0.35, fastProb: 0.03, neutrons: [2, 2], heat: 1600, daughters: ["barium_141", "krypton_92", "xenon_135"] },
    plutonium: { thermalProb: 0.82, fastProb: 0.22, neutrons: [2, 3], heat: 2700, daughters: ["barium_141", "xenon_135", "strontium_90"] },
    enriched_uranium: { thermalProb: 0.76, fastProb: 0.08, neutrons: [2, 3], heat: 2400, daughters: ["barium_141", "krypton_92", "xenon_135", "strontium_90"] }
  };

  function spawnNeutronsAround(cx, cy, count, type = "fast_neutron") {
    syncPhysicsTick();
    if (prevTickNeutrons + spawnedThisTick >= MAX_NEUTRONS) return;
    if (spawnedThisTick >= MAX_SPAWN_PER_TICK) return;

    const dirs = [
      [-1, -1], [0, -1], [1, -1],
      [-1,  0],          [1,  0],
      [-1,  1], [0,  1], [1,  1]
    ];
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
        if (outOfBounds(nx, ny)) break;
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
    const tx = targetPixel.x;
    const ty = targetPixel.y;

    // 1. Transmute fissile nucleus into a realistic fission daughter
    const daughter = spec.daughters[Math.floor(Math.random() * spec.daughters.length)];
    changePixel(targetPixel, daughter);

    // 2. Deposit fission kinetic energy as heat
    targetPixel.temp += spec.heat;
    let nearbyFissile = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (outOfBounds(nx, ny)) continue;
        const p = pixelMap[nx][ny];
        if (p) {
          p.temp += Math.round(spec.heat * 0.18);
          if (FISSILE_SPECS[p.element]) nearbyFissile++;
        }
      }
    }

    // 3. Consume incident neutron
    if (neutronPixel && pixelMap[neutronPixel.x]?.[neutronPixel.y] === neutronPixel) {
      deletePixel(neutronPixel.x, neutronPixel.y);
    }

    // 4. Emit 2-3 prompt fast neutrons (respecting global cap)
    const nCount = spec.neutrons[0] + (Math.random() < 0.5 ? (spec.neutrons[1] - spec.neutrons[0]) : 0);
    spawnNeutronsAround(tx, ty, nCount, "fast_neutron");

    // 5. Throttled Prompt-Critical Hydrodynamic Disassembly
    if (targetPixel.temp > 6000 && nearbyFissile >= 10 && (lastPhysicsTick - lastExplodeTick >= EXPLODE_COOLDOWN_TICKS)) {
      lastExplodeTick = lastPhysicsTick;
      explodeAt(tx, ty, 8, "plasma,fire,radiation,fallout");
    }
  }

  function neutronTick(pixel, isFast) {
    syncPhysicsTick();
    neutronsThisTick++;

    // Gracefully cull excess neutrons if a runaway spikes past the cap
    if (neutronsThisTick > MAX_NEUTRONS * 1.25) {
      deletePixel(pixel.x, pixel.y);
      return;
    }

    if (pixel.vx === undefined || pixel.vy === undefined || (pixel.vx === 0 && pixel.vy === 0)) {
      const dirs = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
      const d = dirs[Math.floor(Math.random() * dirs.length)];
      pixel.vx = d[0];
      pixel.vy = d[1];
    }
    if (pixel.life === undefined) pixel.life = 90;
    pixel.life--;

    // Free neutron beta decay (n -> p + e- + antineutrino)
    if (pixel.life <= 0) {
      changePixel(pixel, "proton");
      return;
    }

    const steps = isFast ? 2 : 1;
    for (let s = 0; s < steps; s++) {
      const nx = pixel.x + pixel.vx;
      const ny = pixel.y + pixel.vy;

      if (outOfBounds(nx, ny)) {
        deletePixel(pixel.x, pixel.y);
        return;
      }

      if (isEmpty(nx, ny)) {
        movePixel(pixel, nx, ny);
        continue;
      }

      const target = pixelMap[nx][ny];
      if (!target) continue;
      const tElem = target.element;

      // A. Fission on fissile nuclei
      if (FISSILE_SPECS[tElem]) {
        const spec = FISSILE_SPECS[tElem];
        const prob = isFast ? spec.fastProb : spec.thermalProb;
        if (Math.random() < prob) {
          triggerFission(target, spec, pixel);
          return;
        } else {
          if (Math.random() < 0.5) {
            swapPixels(pixel, target);
          } else {
            pixel.vx = -pixel.vx;
            pixel.vy = -pixel.vy;
          }
          return;
        }
      }

      // B. Fertile breeding reactions
      if (tElem === "uranium_238" || tElem === "molten_uranium_238") {
        if (Math.random() < (isFast ? 0.12 : 0.35)) {
          changePixel(target, "neptunium_239");
          target.temp += 150;
          deletePixel(pixel.x, pixel.y);
          return;
        }
      } else if (tElem === "thorium_232" || tElem === "molten_thorium_232" || tElem === "thorium") {
        if (Math.random() < (isFast ? 0.10 : 0.38)) {
          changePixel(target, "protactinium_233");
          target.temp += 140;
          deletePixel(pixel.x, pixel.y);
          return;
        }
      }

      // C. Tritium breeding blanket (Li-6 + n -> T + He-4)
      if (tElem === "lithium_6" || tElem === "molten_lithium_6") {
        if (Math.random() < 0.55) {
          changePixel(target, "tritium");
          target.temp += 850;
          changePixel(pixel, "helium");
          return;
        }
      }

      // D. Cobalt-59 neutron activation -> Cobalt-60
      if (tElem === "cobalt" || tElem === "molten_cobalt") {
        if (Math.random() < 0.30) {
          changePixel(target, "cobalt_60");
          target.temp += 120;
          deletePixel(pixel.x, pixel.y);
          return;
        }
      }

      // E. Control rods & reactor poisons (Boron, Cadmium, Xenon-135)
      if (POISONS.has(tElem)) {
        const absorbProb = tElem === "xenon_135" ? 0.96 : 0.85;
        if (!isFast && Math.random() < absorbProb) {
          target.temp += 80;
          if (tElem === "boron" && Math.random() < 0.15) {
            changePixel(target, "lithium_7");
          } else if (tElem === "xenon_135") {
            changePixel(target, "xenon_136");
          }
          deletePixel(pixel.x, pixel.y);
          return;
        }
      }

      // F. Moderators (slow fast neutrons -> thermal neutrons)
      if (MODERATORS.has(tElem)) {
        target.temp += isFast ? 35 : 5;
        if (isFast) {
          if (tElem === "water" && Math.random() < 0.06) {
            changePixel(target, "heavy_water");
            deletePixel(pixel.x, pixel.y);
            return;
          }
          changePixel(pixel, "thermal_neutron");
          pixel.vx = Math.floor(Math.random() * 3) - 1;
          pixel.vy = Math.floor(Math.random() * 3) - 1;
          return;
        } else {
          swapPixels(pixel, target);
          return;
        }
      }

      // G. Neutron Reflectors (Beryllium, Tungsten)
      if (REFLECTORS.has(tElem)) {
        pixel.vx = -pixel.vx + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0);
        pixel.vy = -pixel.vy + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0);
        pixel.vx = Math.max(-1, Math.min(1, pixel.vx));
        pixel.vy = Math.max(-1, Math.min(1, pixel.vy));
        // Beryllium (n, 2n) triggers at most once per neutron to prevent infinite reflection loops
        if (isFast && !pixel.beMultiplied && (tElem === "beryllium" || tElem === "molten_beryllium") && Math.random() < 0.08) {
          pixel.beMultiplied = true;
          spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        }
        return;
      }

      // H. High-Z Shielding (Lead, Concrete, Osmium)
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
        swapPixels(pixel, target);
      } else {
        pixel.vx = Math.floor(Math.random() * 3) - 1;
        pixel.vy = Math.floor(Math.random() * 3) - 1;
        return;
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
    desc: "High-energy (~2 MeV) neutron emitted by fission or D-T fusion. Slows down in moderators (heavy water, graphite, water) to become a thermal neutron.",
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
    desc: "Moderated slow neutron (~0.025 eV). Has a very high capture cross-section for fissile isotopes (U-235, Pu-239, U-233) and control rods (Boron, Cadmium, Xe-135).",
    tick: function (pixel) {
      neutronTick(pixel, false);
    }
  };

  // ---------------------------------------------------------------------------
  // 4. HYDROGEN & HELIUM ISOTOPES + ACCURATE FUSION
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
    desc: "Hydrogen-2 (1 proton, 1 neutron). Primary fusion fuel; reacts with oxygen to form heavy water (D2O).",
    reactions: {
      // D-T Fusion (lowest ignition threshold: 10,000 C in Sandboxels scale)
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
      // D-D Fusion (25,000 C) -> 50% T + p, 50% He-3 + n
      deuterium: {
        tempMin: 25000,
        chance: 0.35,
        func: function (p1, p2) {
          if (Math.random() < 0.5) {
            changePixel(p1, "tritium");
            changePixel(p2, "proton");
          } else {
            changePixel(p1, "helium_3");
            changePixel(p2, "fast_neutron");
          }
          p1.temp += 4500;
          p2.temp += 4500;
        }
      },
      // D-He3 Aneutronic Fusion (40,000 C) -> He-4 + p (no neutron radiation!)
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
      // Combustion with oxygen -> Heavy Water
      oxygen: {
        elem1: "heavy_steam",
        elem2: "fire",
        tempMin: 560,
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
    desc: "Radioactive Hydrogen-3 (1 proton, 2 neutrons). Fuses easily with Deuterium at high temp; beta-decays slowly into Helium-3.",
    tick: function (pixel) {
      // Slow beta decay into Helium-3
      if (Math.random() < 0.00015) {
        changePixel(pixel, "helium_3");
        pixel.temp += 5;
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
    desc: "Light, non-radioactive Helium isotope. Enables clean aneutronic fusion with Deuterium at ~40,000 C."
  });

  // Heavy Water (D2O) + Heavy Ice + Heavy Steam
  elements.heavy_water = {
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
    desc: "Deuterium Oxide (D2O). Superior neutron moderator that slows fast neutrons without absorbing them, allowing natural uranium to go critical."
  };

  elements.heavy_ice = {
    color: ["#a8d0f5", "#b8daf8"],
    behavior: behaviors.WALL,
    category: "states",
    state: "solid",
    hidden: true,
    density: 1017,
    temp: 0,
    tempHigh: 3.8,
    stateHigh: "heavy_water"
  };

  elements.heavy_steam = {
    color: ["#c7dbf0", "#d7e6f5"],
    behavior: behaviors.GAS,
    category: "states",
    state: "gas",
    hidden: true,
    density: 0.66,
    temp: 110,
    tempLow: 101.4,
    stateLow: "heavy_water"
  };

  // ---------------------------------------------------------------------------
  // 5. FISSILE, FERTILE & DECAY ISOTOPES (WITH FULL SOLID/MOLTEN/GAS CHAINS)
  // ---------------------------------------------------------------------------

  // Uranium-235 (Fissile)
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
    desc: "Fissile Uranium-235. Splits upon capturing a thermal neutron, releasing ~200 MeV of heat, 2-3 fast neutrons, and fission products.",
    tick: function (pixel) {
      // Rare spontaneous fission neutron to kick off supercritical assemblies
      if (Math.random() < 0.00025) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      }
      doDefaults(pixel);
    }
  });

  // Uranium-238 (Fertile)
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
    desc: "Fertile Depleted Uranium (U-238). Absorbs neutrons to breed Neptunium-239, which beta-decays into fissile Plutonium-239."
  });

  // Neptunium-239 (Intermediate Breeder Isotope)
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
    desc: "Short-lived isotope bred from U-238 + neutron. Beta-decays into Plutonium-239.",
    tick: function (pixel) {
      pixel.temp += 0.08;
      if (Math.random() < 0.003) {
        changePixel(pixel, "plutonium_239");
        pixel.temp += 60;
      }
      doDefaults(pixel);
    }
  });

  // Plutonium-239 (Fissile)
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
    desc: "Fissile Plutonium-239. Higher fast-neutron fission cross-section than U-235; warm to the touch from alpha decay.",
    tick: function (pixel) {
      pixel.temp += 0.05; // Alpha decay self-heating
      if (Math.random() < 0.0006) {
        spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
      }
      doDefaults(pixel);
    }
  });

  // Thorium-232 (Fertile)
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
    desc: "Fertile Thorium-232. Captures neutrons to breed Protactinium-233, which decays into fissile Uranium-233."
  });

  // Protactinium-233 (Intermediate Thorium Breeder Isotope)
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
    desc: "Intermediate isotope in the Thorium fuel cycle. Beta-decays into fissile Uranium-233.",
    tick: function (pixel) {
      pixel.temp += 0.06;
      if (Math.random() < 0.002) {
        changePixel(pixel, "uranium_233");
        pixel.temp += 50;
      }
      doDefaults(pixel);
    }
  });

  // Uranium-233 (Fissile)
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
    desc: "Fissile Uranium-233 bred from Thorium-232. High thermal neutron efficiency."
  });

  // ---------------------------------------------------------------------------
  // 6. FISSION PRODUCTS & REACTOR POISONS
  // ---------------------------------------------------------------------------

  // Xenon-135 (Notorious Reactor Poison!)
  defineFullGas({
    id: "xenon_135",
    color: ["#9a78e3", "#b091f2"],
    liquidColor: ["#6c47bd", "#7d55d1"],
    solidColor: ["#c6b3f5", "#d8c9fa"],
    category: "isotopes",
    boilTemp: -108.1,
    meltTemp: -111.8,
    density: 5.89,
    desc: "Fission product with the highest known thermal neutron absorption cross-section. Poisons reactors until it burns off or decays into Cesium-135.",
    tick: function (pixel) {
      if (Math.random() < 0.0012) {
        changePixel(pixel, "cesium_135");
      }
      doDefaults(pixel);
    }
  });

  // Xenon-136 (Stable burnout product of Xe-135 + n)
  defineFullGas({
    id: "xenon_136",
    color: ["#7c6fa8", "#9183bd"],
    liquidColor: ["#5a4d82", "#695a94"],
    solidColor: ["#b5abdb", "#c8c0e6"],
    category: "isotopes",
    boilTemp: -108.1,
    meltTemp: -111.8,
    density: 5.93,
    desc: "Virtually stable Xenon isotope formed when Xenon-135 absorbs a neutron."
  });

  // Krypton-92 (Fission product gas)
  defineFullGas({
    id: "krypton_92",
    color: ["#b8d4e8", "#cfe5f5"],
    liquidColor: ["#80a8c7", "#92bad9"],
    solidColor: ["#dcebf7", "#ebf4fc"],
    category: "isotopes",
    boilTemp: -153.4,
    meltTemp: -157.4,
    density: 3.75,
    desc: "Radioactive fission product gas. Decays rapidly with heat release.",
    tick: function (pixel) {
      pixel.temp += 0.15;
      if (Math.random() < 0.004) {
        changePixel(pixel, "strontium_90");
      }
      doDefaults(pixel);
    }
  });

  // Barium-141
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
    desc: "Radioactive fission product of U-235. Emits decay heat.",
    tick: function (pixel) {
      pixel.temp += 0.12;
      doDefaults(pixel);
    }
  });

  // Strontium-90
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
    desc: "Long-lived radioactive fission product (used in RTGs). Produces steady decay heat.",
    tick: function (pixel) {
      pixel.temp += 0.08;
      doDefaults(pixel);
    }
  });

  // Cesium-135
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
  // 7. REACTOR ENGINEERING MATERIALS & EXOTIC ELEMENTS (MISSING FROM CHEM.JS)
  // ---------------------------------------------------------------------------

  // Graphite (Moderator)
  elements.graphite = {
    color: ["#2b2b2e", "#36363a", "#232326"],
    behavior: behaviors.WALL,
    category: "nuclear",
    state: "solid",
    density: 2260,
    conduct: 0.85,
    hardness: 0.65,
    tempHigh: 3642,
    stateHigh: "carbon_dioxide",
    desc: "Crystalline carbon neutron moderator and electrical conductor. Slows fast neutrons effectively; withstands extreme heat.",
    reactions: {
      oxygen: { elem1: "carbon_dioxide", elem2: "fire", tempMin: 750, chance: 0.15 }
    }
  };

  // Beryllium (Neutron Reflector & Multiplier)
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
    desc: "Light, stiff metal that reflects and multiplies fast neutrons via (n, 2n). Reacts with Polonium-210 alpha particles to form a neutron source!",
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

  // Boron (Control Rod)
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

  // Cadmium (Control Rod)
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
    desc: "Soft bluish-white metal with a huge thermal neutron capture cross-section. Classic control-rod material."
  });

  // Lithium-6 (Tritium Breeder)
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
    desc: "Lithium-6 isotope. Absorbs neutrons to breed Tritium + Helium-4 for fusion blankets. Reacts vigorously with water.",
    reactions: {
      water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: function (p1, p2) { p1.temp += 300; } }
    }
  });

  // Lithium-7
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
    desc: "Most abundant Lithium isotope. Low neutron absorption; used in molten-salt reactor coolants.",
    reactions: {
      water: { elem1: "hydrogen", elem2: "fire", chance: 0.4, func: function (p1, p2) { p1.temp += 300; } }
    }
  });

  // Cobalt-59 & Cobalt-60 (Neutron Activation)
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
    desc: "Ferromagnetic transition metal. Absorbs neutrons to become intensely radioactive Cobalt-60."
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
        if (!outOfBounds(nx, ny) && isEmpty(nx, ny)) {
          createPixel("radiation", nx, ny);
        }
      }
      doDefaults(pixel);
    }
  });

  // Polonium-210 (Alpha Emitter / Neutron Initiator with Beryllium)
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
    desc: "Intense alpha emitter (~140 W/g decay heat). Place next to Beryllium to build a real neutron initiator!",
    tick: function (pixel) {
      pixel.temp += 0.45; // Real Po-210 glows hot from alpha decay!
      if (Math.random() < 0.01) {
        const d = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
        const nx = pixel.x + d[0];
        const ny = pixel.y + d[1];
        if (!outOfBounds(nx, ny) && isEmpty(nx, ny)) {
          createPixel("radiation", nx, ny);
        }
      }
      doDefaults(pixel);
    }
  });

  // Radon-222 (Heavy Radioactive Noble Gas)
  defineFullGas({
    id: "radon",
    color: ["#b8e0c8", "#ccebd8"],
    liquidColor: ["#8ac2a0", "#9cd4b2"],
    solidColor: ["#ffaa55", "#ff8844"], // Solid radon glows yellow-orange from radioluminescence!
    category: "isotopes",
    boilTemp: -61.7,
    meltTemp: -71.0,
    density: 9.73, // Very heavy gas — sinks!
    desc: "Dense radioactive noble gas. Sinks in air, glows orange-yellow when frozen, and decays into Polonium-210.",
    tick: function (pixel) {
      if (Math.random() < 0.0005) {
        changePixel(pixel, "polonium_210");
        pixel.temp += 20;
      }
      doDefaults(pixel);
    }
  });

  // Cesium (Melts at 28.5 C, explodes violently with water!)
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
    desc: "Silvery-gold alkali metal that melts just above room temperature (28.5 C). Detonates violently on contact with water or ice.",
    reactions: {
      water: {
        chance: 0.9,
        func: function (p1, p2) {
          changePixel(p1, "hydrogen");
          p1.temp += 1200;
          explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam");
        }
      },
      ice: {
        chance: 0.7,
        func: function (p1, p2) {
          changePixel(p1, "hydrogen");
          explodeAt(p1.x, p1.y, 4, "fire,hydrogen,steam");
        }
      },
      oxygen: { elem1: "fire", elem2: "ash", tempMin: 40, chance: 0.35 }
    }
  });

  // Rubidium (Melts at 39.3 C, violent water reaction)
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
    desc: "Soft alkali metal (melts at 39.3 C). Ignites spontaneously in air and reacts explosively with water.",
    reactions: {
      water: {
        chance: 0.85,
        func: function (p1, p2) {
          changePixel(p1, "hydrogen");
          explodeAt(p1.x, p1.y, 3, "fire,hydrogen,steam");
        }
      }
    }
  });

  // Gallium (Melts at 29.8 C, Liquid Metal Embrittlement on Aluminum!)
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
    desc: "Melts in your hand (29.8 C). Penetrates aluminum grain boundaries, turning solid aluminum into brittle powder!",
    reactions: {
      aluminum: {
        elem2: "metal_scrap",
        chance: 0.18
      }
    }
  });

  // Osmium (Densest naturally occurring element!)
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
    desc: "Densest natural element on Earth (22,590 kg/m^3). Bluish-silver, ultra-hard, and sinks through nearly every liquid."
  });

  // ---------------------------------------------------------------------------
  // 8. PATCH VANILLA & CHEM.JS ELEMENTS AFTER LOAD
  // ---------------------------------------------------------------------------

  runAfterLoad(function () {
    // 1. Patch vanilla neutron so it participates in the accurate fission/moderation engine
    if (elements.neutron) {
      elements.neutron.desc = "Free neutron (enhanced by Nuclear & Chemistry Plus). Moderates in water/graphite and triggers accurate fission.";
      elements.neutron.tick = function (pixel) {
        neutronTick(pixel, true);
      };
    }

    // 2. Patch vanilla Uranium: remove arbitrary random explosions, keep realistic decay & neutron fission
    if (elements.uranium) {
      elements.uranium.desc = "Natural/Low-Enriched Uranium (patched). No random explosions — requires thermal neutrons (use a moderator!) for a sustained chain reaction.";
      elements.uranium.tick = function (pixel) {
        if (Math.random() < 0.0001) {
          spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        }
        doDefaults(pixel);
      };
    }

    // 3. Patch vanilla Plutonium if present
    if (elements.plutonium) {
      elements.plutonium.desc = "Plutonium-239 (patched). Self-heats via alpha decay and fissions on both thermal and fast neutrons.";
      elements.plutonium.tick = function (pixel) {
        pixel.temp += 0.05;
        if (Math.random() < 0.0005) {
          spawnNeutronsAround(pixel.x, pixel.y, 1, "fast_neutron");
        }
        doDefaults(pixel);
      };
    }

    // 4. Patch Hydrogen (Protium) for stellar p-p fusion at extreme temps (50,000 C)
    if (elements.hydrogen) {
      safeAddReaction("hydrogen", "hydrogen", {
        elem1: "deuterium",
        elem2: "positron",
        tempMin: 50000,
        chance: 0.15,
        func: function (p1, p2) {
          p1.temp += 4000;
        }
      });
    }

    // 5. Patch Helium for Triple-Alpha stellar fusion (65,000 C) -> Carbon / Graphite
    if (elements.helium) {
      safeAddReaction("helium", "helium", {
        elem1: "graphite",
        elem2: "radiation",
        tempMin: 65000,
        chance: 0.12,
        func: function (p1, p2) {
          p1.temp += 6000;
        }
      });
    }

    // 6. Patch molten Gallium to embrittle Aluminum just like solid Gallium
    if (elements.molten_gallium && elements.aluminum) {
      safeAddReaction("molten_gallium", "aluminum", {
        elem2: "metal_scrap",
        chance: 0.35
      });
    }

    // 7. Integrate with chem.js enriched_uranium / uranium_dioxide if loaded
    if (elements.uranium_dioxide) {
      FISSILE_SPECS.uranium_dioxide = {
        thermalProb: 0.45,
        fastProb: 0.04,
        neutrons: [2, 3],
        heat: 1850,
        daughters: ["barium_141", "krypton_92", "xenon_135"]
      };
    }
  });
})();
