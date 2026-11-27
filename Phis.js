// ============================================================================
// unified_voxel_physics.js
// Unified 2D Voxel Physics, Astrophysics & Chemistry Simulation for Sandboxels
// Implements: 4-Pass HiDPI Pipeline, CFL Sub-Stepping, Conservation Ledger,
// Continuous Sub-Pixel Kinematics, stored_voxels Compression Stacking,
// All 118 Periodic Elements, Flag-Based Isotopes, Two-Tier Hybrid Cache/Solver,
// Coarse-Grid Poisson Gravity & Unified EoS, Stellar Evolution & Remnants,
// Sub-Grid Neutron Fission, Vector-Line Chemical Bonds, Vector MHD & Radiative
// Transfer, plus Dynamic Voxel Scale Configuration Menu (Atom -> 10,000 km+).
// ============================================================================

(function () {
  "use strict";

  if (window.__UPCS_LOADED__) return;
  window.__UPCS_LOADED__ = true;

  // ==========================================================================
  // 1. PHYSICAL CONSTANTS & VOXEL SCALE CONFIGURATION
  // ==========================================================================
  const PHYS = {
    G: 6.67430e-11,           // m^3 kg^-1 s^-2
    c: 2.99792458e8,          // m/s
    k_B: 1.380649e-23,        // J/K
    sigma_SB: 5.670374419e-8, // W m^-2 K^-4
    a_rad: 7.5657e-16,        // J m^-3 K^-4 (4*sigma/c)
    N_A: 6.02214076e23,       // mol^-1
    R_gas: 8.314462618,       // J mol^-1 K^-1
    amu: 1.6605390666e-27,    // kg
    e_charge: 1.602176634e-19,// C
    MeV_to_J: 1.602176634e-13,// J
    kJmol_to_J: 1000 / 6.02214076e23,
    M_sun: 1.98847e30,        // kg
    M_chandra: 1.44 * 1.98847e30,
    M_tov: 2.2 * 1.98847e30,
    rho_nuc: 2.8e17           // kg/m^3 (2.8e14 g/cm^3)
  };

  const SCALE_PRESETS = [
    { id: "atom",   label: "Atom (1.5 Å)",  meters: 1.5e-10, autoDt: 1e-14,  isAtomic: true,  desc: "Single atom per voxel; direct covalent bonds & isotope reactions" },
    { id: "1nm",    label: "1 nm × 1 nm",   meters: 1e-9,    autoDt: 1e-12,  isAtomic: false, desc: "Nanocluster & molecular lattice scale" },
    { id: "1um",    label: "1 µm × 1 µm",   meters: 1e-6,    autoDt: 1e-7,   isAtomic: false, desc: "Micro-grain & aerosol physics" },
    { id: "1mm",    label: "1 mm × 1 mm",   meters: 1e-3,    autoDt: 1e-3,   isAtomic: false, desc: "Lab droplet, crystal & spark scale" },
    { id: "1cm",    label: "1 cm × 1 cm",   meters: 1e-2,    autoDt: 1e-2,   isAtomic: false, desc: "Benchtop chemistry, magnets & Demon Core fission" },
    { id: "10cm",   label: "10 cm × 10 cm", meters: 1e-1,    autoDt: 2e-2,   isAtomic: false, desc: "Reactor core, plasma tokamak & industrial vessels" },
    { id: "1m",     label: "1 m × 1 m",     meters: 1,       autoDt: 5e-2,   isAtomic: false, desc: "Room-scale explosions, reactors & fluid dynamics" },
    { id: "10m",    label: "10 m × 10 m",   meters: 10,      autoDt: 0.1,    isAtomic: false, desc: "Structure & plume convection scale" },
    { id: "100m",   label: "100 m × 100 m", meters: 100,     autoDt: 0.5,    isAtomic: false, desc: "Small asteroid & self-gravity threshold" },
    { id: "1km",    label: "1 km × 1 km",   meters: 1e3,     autoDt: 2.0,    isAtomic: false, desc: "Neutron stars, moonlets & micro black holes" },
    { id: "100km",  label: "100 km × 100 km", meters: 1e5,   autoDt: 20.0,   isAtomic: false, desc: "Planetary cores & white dwarfs" },
    { id: "10000km",label: "10,000 km (Star)", meters: 1e7,  autoDt: 3600.0, isAtomic: false, desc: "Full stellar evolution, red giants, supernovae & black holes" }
  ];

  const UNIT_TO_METERS = {
    A: 1e-10, nm: 1e-9, um: 1e-6, mm: 1e-3, cm: 1e-2, m: 1, km: 1e3, Mm: 1e6
  };

  const CONFIG = {
    scalePreset: "1cm",
    voxelSizeMeters: 1e-2,
    isAtomicMode: false,
    autoDt: true,
    dtSim: 1e-2,              // physical seconds per frame tick
    substeps: 4,              // 4..8 CFL substeps
    cflMaxDisp: 0.48,         // <= 0.5 grid cells per substep

    // Forces & Gravity
    enableKinematics: true,
    enableGravity: true,
    coarseBlockSize: 4,       // 4x4 or 8x8 Poisson grid
    poissonIterations: 12,
    gravityMultiplier: 1.0,
    earthDownwardG: false,    // optional 9.81 m/s^2 lab floor gravity
    restitution: 0.35,
    dragCoeff: 0.015,
    enableVorticity: true,
    vorticityStrength: 0.18,

    // Compression & Stacking
    enableCompression: true,
    enableMultiVoxelStack: true,
    packingChiThreshold: 2.0,
    maxStoredPerCell: 64,
    compressionBrightK: 0.38,
    maxBrightness: 2.6,

    // Nuclear & Stellar
    enableFusion: true,
    fusionRateMult: 1.0,
    sandboxScaledAstro: true, // allows stellar/remnant thresholds to trigger smoothly at sandbox cell counts
    enableFission: true,
    enableDecay: true,
    enableRadiativeTransfer: true,

    // Chemistry & Magnetism
    enableBonding: true,
    bondStiffnessScale: 1.0,
    enableCatalysts: true,
    enableMagnetism: true,
    externalBx: 0.0,
    externalBy: 0.0,

    // 4-Pass Visuals
    fullCustomRenderer: true,
    bgColor: "#07090E",
    showGravityContours: false,
    showMagneticLines: false,
    showVectorBonds: true,
    enableHDRBloom: true,
    bloomIntensity: 0.85,
    showNeutronsAndPhotons: true,

    // Brush Isotope Override (null = default A for painted element)
    brushIsotopeA: null,
    brushMetastable: false,
    brushCharge: 0,
    brushDipole: 0
  };

  // ==========================================================================
  // 2. ALL 118 CANONICAL PERIODIC TABLE ELEMENTS
  // Compact tuple:
  // [Z, sym, name, A_def, grp, valSlots, valElec, chiEN, rCov_pm, IE_eV,
  //  D_AA_kJ, rho0_gcm3, K_GPa, Cv_JgK, mp_C, bp_C, dHfus_kJ, dHvap_kJ, Tc_K, hex]
  // Groups: NM=Nonmetals, NG=Noble Gases, AM=Alkali Metals, AE=Alkaline Earth,
  // TM=Transition Metals, PT=Post-Transition, ML=Metalloids, LN=Lanthanides, AN=Actinides
  // ==========================================================================
  const GROUP_META = {
    NM: { cat: "pt_nonmetals",      title: "Nonmetals" },
    NG: { cat: "pt_noble_gases",    title: "Noble Gases" },
    AM: { cat: "pt_alkali",         title: "Alkali Metals" },
    AE: { cat: "pt_alkaline_earth", title: "Alkaline Earth" },
    TM: { cat: "pt_transition",     title: "Transition Metals" },
    PT: { cat: "pt_post_transition",title: "Post-Transition" },
    ML: { cat: "pt_metalloids",     title: "Metalloids" },
    LN: { cat: "pt_lanthanides",    title: "Lanthanides" },
    AN: { cat: "pt_actinides",      title: "Actinides" }
  };

  const RAW_ELEMENTS = [
    [1,"H","Hydrogen",1,"NM",1,1,2.20,31,13.60,436,0.00009,0.2,14.30,-259.2,-252.9,0.12,0.90,0,"#7DD3FC"],
    [2,"He","Helium",4,"NG",0,2,0.00,28,24.59,0.01,0.00018,0.1,5.19,-272.2,-268.9,0.02,0.08,0,"#FDE68A"],
    [3,"Li","Lithium",7,"AM",1,1,0.98,128,5.39,105,0.534,11,3.58,180.5,1342,3.0,147,0,"#D8B4FE"],
    [4,"Be","Beryllium",9,"AE",2,2,1.57,96,9.32,59,1.85,130,1.82,1287,2469,12.2,297,0,"#A7F3D0"],
    [5,"B","Boron",11,"ML",3,3,2.04,84,8.30,297,2.34,185,1.03,2076,3927,50.2,489,0,"#FDBA74"],
    [6,"C","Carbon",12,"NM",4,4,2.55,76,11.26,348,2.267,33,0.71,3550,4027,117,355,0,"#475569"],
    [7,"N","Nitrogen",14,"NM",3,5,3.04,71,14.53,163,0.00125,0.3,1.04,-210.0,-195.8,0.72,5.57,0,"#60A5FA"],
    [8,"O","Oxygen",16,"NM",2,6,3.44,66,13.62,146,0.00143,0.3,0.92,-218.8,-183.0,0.44,6.82,0,"#38BDF8"],
    [9,"F","Fluorine",19,"NM",1,7,3.98,57,17.42,159,0.00170,0.4,0.82,-219.7,-188.1,0.51,6.62,0,"#BEF264"],
    [10,"Ne","Neon",20,"NG",0,8,0.00,58,21.56,0.04,0.00090,0.1,1.03,-248.6,-246.1,0.33,1.71,0,"#FB7185"],
    [11,"Na","Sodium",23,"AM",1,1,0.93,166,5.14,74,0.968,6.3,1.23,97.8,883,2.6,97.4,0,"#E2E8F0"],
    [12,"Mg","Magnesium",24,"AE",2,2,1.31,141,7.65,11,1.738,45,1.02,650,1091,8.48,128,0,"#CBD5E1"],
    [13,"Al","Aluminum",27,"PT",3,3,1.61,121,5.99,186,2.70,76,0.90,660.3,2470,10.7,294,0,"#94A3B8"],
    [14,"Si","Silicon",28,"ML",4,4,1.90,111,8.15,226,2.329,100,0.71,1414,3265,50.2,359,0,"#64748B"],
    [15,"P","Phosphorus",31,"NM",3,5,2.19,107,10.49,201,1.823,11,0.77,44.1,280.5,0.66,12.4,0,"#FB923C"],
    [16,"S","Sulfur",32,"NM",2,6,2.58,105,10.36,266,2.07,7.7,0.71,115.2,444.6,1.73,45,0,"#FACC15"],
    [17,"Cl","Chlorine",35,"NM",1,7,3.16,102,12.97,243,0.00321,0.5,0.48,-101.5,-34.0,6.41,20.4,0,"#84CC16"],
    [18,"Ar","Argon",40,"NG",0,8,0.00,106,15.76,0.12,0.00178,0.1,0.52,-189.4,-185.8,1.18,6.53,0,"#A5B4FC"],
    [19,"K","Potassium",39,"AM",1,1,0.82,203,4.34,54,0.862,3.1,0.76,63.5,759,2.33,76.9,0,"#C4B5FD"],
    [20,"Ca","Calcium",40,"AE",2,2,1.00,176,6.11,16,1.55,17,0.65,842,1484,8.54,154.7,0,"#E5E7EB"],
    [21,"Sc","Scandium",45,"TM",3,3,1.36,170,6.56,163,2.985,57,0.57,1541,2836,14.1,332.7,0,"#D1D5DB"],
    [22,"Ti","Titanium",48,"TM",4,4,1.54,160,6.83,118,4.506,110,0.52,1668,3287,14.15,425,0,"#9CA3AF"],
    [23,"V","Vanadium",51,"TM",5,5,1.63,153,6.75,269,6.0,160,0.49,1910,3407,21.5,459,0,"#818CF8"],
    [24,"Cr","Chromium",52,"TM",3,6,1.66,139,6.77,143,7.19,160,0.45,1907,2671,21.0,339.5,0,"#93C5FD"],
    [25,"Mn","Manganese",55,"TM",4,7,1.55,139,7.43,42,7.21,120,0.48,1246,2061,12.9,221,0,"#A78BFA"],
    [26,"Fe","Iron",56,"TM",3,8,1.83,132,7.90,118,7.874,170,0.45,1538,2862,13.8,340,1043,"#B45309"],
    [27,"Co","Cobalt",59,"TM",3,9,1.88,126,7.88,167,8.90,180,0.42,1495,2927,16.06,377,1388,"#3B82F6"],
    [28,"Ni","Nickel",59,"TM",2,10,1.91,124,7.64,204,8.908,180,0.44,1455,2730,17.48,377.5,627,"#86EFAC"],
    [29,"Cu","Copper",64,"TM",2,11,1.90,132,7.73,201,8.96,140,0.39,1084.6,2562,13.26,300.4,0,"#EA580C"],
    [30,"Zn","Zinc",65,"TM",2,12,1.65,122,9.39,29,7.14,70,0.39,419.5,907,7.32,123.6,0,"#71717A"],
    [31,"Ga","Gallium",70,"PT",3,3,1.81,122,6.00,138,5.91,56,0.37,29.8,2400,5.59,254,0,"#67E8F9"],
    [32,"Ge","Germanium",73,"ML",4,4,2.01,120,7.90,264,5.323,75,0.32,938.2,2833,36.94,334,0,"#78716C"],
    [33,"As","Arsenic",75,"ML",3,5,2.18,119,9.79,382,5.727,22,0.33,817,615,24.44,34.76,0,"#A8A29E"],
    [34,"Se","Selenium",79,"NM",2,6,2.55,120,9.75,332,4.81,8.3,0.32,221,685,6.69,95.48,0,"#F97316"],
    [35,"Br","Bromine",80,"NM",1,7,2.96,120,11.81,193,3.103,1.9,0.47,-7.2,58.8,10.57,29.96,0,"#991B1B"],
    [36,"Kr","Krypton",84,"NG",0,8,3.00,116,14.00,0.17,0.00375,0.1,0.25,-157.4,-153.2,1.64,9.08,0,"#6366F1"],
    [37,"Rb","Rubidium",85,"AM",1,1,0.82,220,4.18,49,1.532,2.5,0.36,39.3,688,2.19,69,0,"#C084FC"],
    [38,"Sr","Strontium",88,"AE",2,2,0.95,195,5.69,16,2.64,12,0.30,777,1377,7.43,136.9,0,"#FCA5A5"],
    [39,"Y","Yttrium",89,"TM",3,3,1.22,190,6.22,159,4.472,41,0.30,1526,2930,11.42,365,0,"#99F6E4"],
    [40,"Zr","Zirconium",91,"TM",4,4,1.33,175,6.63,298,6.52,91,0.28,1855,4409,14,573,0,"#A3E635"],
    [41,"Nb","Niobium",93,"TM",5,5,1.60,164,6.76,513,8.57,170,0.27,2477,4744,30,689.9,0,"#5EEAD4"],
    [42,"Mo","Molybdenum",96,"TM",6,6,2.16,154,7.09,436,10.28,230,0.25,2623,4639,37.48,598,0,"#38BDF8"],
    [43,"Tc","Technetium",98,"TM",5,7,1.90,147,7.28,330,11.5,280,0.25,2157,4265,33.29,585.2,0,"#2DD4BF"],
    [44,"Ru","Ruthenium",101,"TM",4,8,2.20,146,7.36,193,12.45,220,0.24,2334,4150,38.59,619,0,"#0EA5E9"],
    [45,"Rh","Rhodium",103,"TM",3,9,2.28,142,7.46,236,12.41,275,0.24,1964,3695,26.59,494,0,"#0284C7"],
    [46,"Pd","Palladium",106,"TM",2,10,2.20,139,8.34,100,12.02,180,0.24,1554.9,2963,16.74,362,0,"#CBD5E1"],
    [47,"Ag","Silver",108,"TM",1,11,1.93,145,7.58,163,10.49,100,0.24,961.8,2162,11.28,250.6,0,"#F1F5F9"],
    [48,"Cd","Cadmium",112,"TM",2,12,1.69,144,8.99,11,8.65,42,0.23,321.1,767,6.21,99.87,0,"#FDE047"],
    [49,"In","Indium",115,"PT",3,3,1.78,142,5.79,100,7.31,41,0.23,156.6,2072,3.28,231.8,0,"#818CF8"],
    [50,"Sn","Tin",119,"PT",4,4,1.96,139,7.34,187,7.265,58,0.23,231.9,2602,7.03,296.1,0,"#94A3B8"],
    [51,"Sb","Antimony",122,"ML",3,5,2.05,139,8.61,299,6.697,42,0.21,630.6,1587,19.79,193.4,0,"#A78BFA"],
    [52,"Te","Tellurium",128,"ML",2,6,2.10,138,9.01,259,6.24,65,0.20,449.5,988,17.49,114.1,0,"#D97706"],
    [53,"I","Iodine",127,"NM",1,7,2.66,139,10.45,151,4.933,7.7,0.21,113.7,184.3,15.52,41.57,0,"#7E22CE"],
    [54,"Xe","Xenon",131,"NG",0,8,2.60,140,12.13,0.24,0.00589,0.1,0.16,-111.8,-108.1,2.27,12.64,0,"#4F46E5"],
    [55,"Cs","Cesium",133,"AM",1,1,0.79,244,3.89,44,1.93,1.6,0.24,28.5,671,2.09,63.9,0,"#EAB308"],
    [56,"Ba","Barium",137,"AE",2,2,0.89,215,5.21,16,3.51,9.6,0.20,727,1845,7.12,140.3,0,"#4ADE80"],
    [57,"La","Lanthanum",139,"LN",3,3,1.10,207,5.58,247,6.162,28,0.20,920,3464,6.20,402.1,0,"#67E8F9"],
    [58,"Ce","Cerium",140,"LN",3,4,1.12,204,5.54,243,6.77,22,0.19,795,3443,5.46,398,0,"#FEF08A"],
    [59,"Pr","Praseodymium",141,"LN",3,5,1.13,203,5.47,130,6.77,29,0.19,935,3130,6.89,331,0,"#86EFAC"],
    [60,"Nd","Neodymium",144,"LN",3,6,1.14,201,5.53,84,7.01,32,0.19,1024,3074,7.14,289,292,"#A7F3D0"],
    [61,"Pm","Promethium",145,"LN",3,7,1.13,199,5.58,80,7.26,33,0.18,1042,3000,7.13,289,0,"#6EE7B7"],
    [62,"Sm","Samarium",150,"LN",3,8,1.17,198,5.64,60,7.52,38,0.20,1072,1900,8.62,165,0,"#34D399"],
    [63,"Eu","Europium",152,"LN",2,9,1.20,198,5.67,34,5.244,8.3,0.18,826,1529,9.21,176,0,"#10B981"],
    [64,"Gd","Gadolinium",157,"LN",3,10,1.20,196,6.15,176,7.90,38,0.24,1312,3273,10.05,301.3,293,"#059669"],
    [65,"Tb","Terbium",159,"LN",3,11,1.10,194,5.86,131,8.23,39,0.18,1356,3123,10.15,296,219,"#047857"],
    [66,"Dy","Dysprosium",163,"LN",3,12,1.22,192,5.94,71,8.54,41,0.17,1407,2562,11.06,280,88,"#14B8A6"],
    [67,"Ho","Holmium",165,"LN",3,13,1.23,192,6.02,84,8.79,40,0.16,1461,2600,17.0,265,20,"#0D9488"],
    [68,"Er","Erbium",167,"LN",3,14,1.24,189,6.11,75,9.066,44,0.17,1529,2868,19.9,280,32,"#0F766E"],
    [69,"Tm","Thulium",169,"LN",3,15,1.25,190,6.18,54,9.32,45,0.16,1545,1950,16.84,247,32,"#06B6D4"],
    [70,"Yb","Ytterbium",173,"LN",3,16,1.10,187,6.25,21,6.90,31,0.15,824,1196,7.66,159,0,"#22D3EE"],
    [71,"Lu","Lutetium",175,"LN",3,3,1.27,187,5.43,142,9.841,48,0.15,1652,3402,22,414,0,"#0891B2"],
    [72,"Hf","Hafnium",178,"TM",4,4,1.30,175,6.83,300,13.31,110,0.14,2233,4603,27.2,571,0,"#38BDF8"],
    [73,"Ta","Tantalum",181,"TM",5,5,1.50,170,7.55,390,16.69,200,0.14,3017,5458,36.57,732.8,0,"#60A5FA"],
    [74,"W","Tungsten",184,"TM",6,6,2.36,162,7.86,522,19.25,310,0.13,3422,5555,52.31,806.7,0,"#64748B"],
    [75,"Re","Rhenium",186,"TM",5,7,1.90,151,7.83,420,21.02,370,0.14,3186,5596,60.43,704,0,"#475569"],
    [76,"Os","Osmium",190,"TM",4,8,2.20,144,8.44,415,22.59,462,0.13,3033,5012,57.85,738,0,"#334155"],
    [77,"Ir","Iridium",192,"TM",4,9,2.20,141,8.97,361,22.56,320,0.13,2446,4428,41.12,563,0,"#94A3B8"],
    [78,"Pt","Platinum",195,"TM",4,10,2.28,136,8.96,307,21.45,230,0.13,1768.3,3825,22.17,469,0,"#E2E8F0"],
    [79,"Au","Gold",197,"TM",3,11,2.54,136,9.23,225,19.30,180,0.13,1064.2,2970,12.55,324,0,"#FACC15"],
    [80,"Hg","Mercury",201,"TM",2,12,2.00,132,10.44,8,13.534,25,0.14,-38.8,356.7,2.29,59.11,0,"#CBD5E1"],
    [81,"Tl","Thallium",204,"PT",3,3,1.62,145,6.11,63,11.85,43,0.13,304,1473,4.14,165,0,"#9CA3AF"],
    [82,"Pb","Lead",207,"PT",4,4,2.33,146,7.42,87,11.34,46,0.13,327.5,1749,4.77,179.5,0,"#52525B"],
    [83,"Bi","Bismuth",209,"PT",3,5,2.02,148,7.29,197,9.78,31,0.12,271.5,1564,11.30,151,0,"#D946EF"],
    [84,"Po","Polonium",209,"PT",2,6,2.00,140,8.42,186,9.196,26,0.12,254,962,13,102.9,0,"#C026D3"],
    [85,"At","Astatine",210,"ML",1,7,2.20,150,9.32,116,6.35,10,0.12,302,337,6,40,0,"#7C3AED"],
    [86,"Rn","Radon",222,"NG",0,8,2.20,150,10.75,0.3,0.00973,0.1,0.09,-71,-61.7,3.25,18.1,0,"#6D28D9"],
    [87,"Fr","Francium",223,"AM",1,1,0.70,260,4.07,42,1.87,1.4,0.15,27,677,2.0,65,0,"#9333EA"],
    [88,"Ra","Radium",226,"AE",2,2,0.90,221,5.28,15,5.5,12,0.09,700,1737,8.5,113,0,"#22C55E"],
    [89,"Ac","Actinium",227,"AN",3,3,1.10,215,5.17,220,10.07,25,0.12,1050,3198,14,400,0,"#38BDF8"],
    [90,"Th","Thorium",232,"AN",4,4,1.30,206,6.31,289,11.72,54,0.12,1750,4788,13.81,514,0,"#4ADE80"],
    [91,"Pa","Protactinium",231,"AN",5,5,1.50,200,5.89,260,15.37,157,0.12,1568,4027,12.34,481,0,"#2DD4BF"],
    [92,"U","Uranium",238,"AN",6,6,1.38,196,6.19,218,19.1,100,0.12,1132.2,4131,9.14,417.1,0,"#22C55E"],
    [93,"Np","Neptunium",237,"AN",5,7,1.36,190,6.27,200,20.45,118,0.12,639,4174,5.19,336,0,"#16A34A"],
    [94,"Pu","Plutonium",239,"AN",4,8,1.28,187,6.03,180,19.82,47,0.13,639.4,3228,2.82,333.5,0,"#15803D"],
    [95,"Am","Americium",243,"AN",3,9,1.13,180,5.97,140,12.0,45,0.11,1176,2607,14.39,238,0,"#84CC16"],
    [96,"Cm","Curium",247,"AN",3,10,1.28,169,5.99,150,13.51,37,0.11,1340,3110,15,290,0,"#65A30D"],
    [97,"Bk","Berkelium",247,"AN",3,11,1.30,168,6.20,140,14.78,30,0.11,986,2627,7.92,260,0,"#A3E635"],
    [98,"Cf","Californium",251,"AN",3,12,1.30,168,6.28,130,15.1,50,0.11,900,1470,8.0,210,0,"#BEF264"],
    [99,"Es","Einsteinium",252,"AN",3,13,1.30,165,6.42,120,8.84,15,0.11,860,996,8.0,160,0,"#D9F99D"],
    [100,"Fm","Fermium",257,"AN",3,14,1.30,167,6.50,110,9.7,15,0.11,1527,2000,10,190,0,"#FDE047"],
    [101,"Md","Mendelevium",258,"AN",3,15,1.30,173,6.58,100,10.3,15,0.11,827,1500,9,170,0,"#FACC15"],
    [102,"No","Nobelium",259,"AN",2,16,1.30,176,6.65,95,9.9,15,0.11,827,1400,9,165,0,"#EAB308"],
    [103,"Lr","Lawrencium",266,"AN",3,3,1.30,161,4.90,150,15.6,40,0.11,1627,2800,12,250,0,"#F59E0B"],
    [104,"Rf","Rutherfordium",267,"TM",4,4,1.30,157,6.01,260,23.2,110,0.11,2100,5500,24,520,0,"#F97316"],
    [105,"Db","Dubnium",268,"TM",5,5,1.50,149,6.89,310,29.3,180,0.11,2800,5600,32,620,0,"#EA580C"],
    [106,"Sg","Seaborgium",269,"TM",6,6,1.90,143,7.85,360,35.0,260,0.11,3100,5700,40,680,0,"#DC2626"],
    [107,"Bh","Bohrium",270,"TM",5,7,1.90,141,7.70,320,37.1,290,0.11,2900,5400,38,640,0,"#EF4444"],
    [108,"Hs","Hassium",277,"TM",4,8,2.10,134,7.60,310,40.7,340,0.10,2700,5100,36,610,0,"#F87171"],
    [109,"Mt","Meitnerium",278,"TM",3,9,2.10,129,8.30,280,37.4,280,0.10,2300,4600,30,520,0,"#FB7185"],
    [110,"Ds","Darmstadtium",281,"TM",4,10,2.20,128,9.60,250,34.8,220,0.10,1800,3900,22,450,0,"#F43F5E"],
    [111,"Rg","Roentgenium",282,"TM",3,11,2.40,121,10.60,210,28.7,170,0.10,1200,3100,15,340,0,"#E11D48"],
    [112,"Cn","Copernicium",285,"TM",2,12,2.10,122,11.97,15,14.0,30,0.10,10,340,4,65,0,"#EC4899"],
    [113,"Nh","Nihonium",286,"PT",3,3,1.80,136,7.31,70,16.0,45,0.10,430,1130,6,130,0,"#DB2777"],
    [114,"Fl","Flerovium",289,"PT",2,4,2.10,143,8.54,50,11.4,35,0.10,-73,107,3,40,0,"#C026D3"],
    [115,"Mc","Moscovium",290,"PT",3,5,2.00,162,5.58,120,13.5,35,0.10,400,1100,10,140,0,"#A855F7"],
    [116,"Lv","Livermorium",293,"PT",2,6,2.10,175,6.80,110,12.9,30,0.10,435,810,11,110,0,"#9333EA"],
    [117,"Ts","Tennessine",294,"ML",1,7,2.20,165,7.70,90,7.2,12,0.10,450,610,10,60,0,"#7E22CE"],
    [118,"Og","Oganesson",294,"NG",0,8,2.10,157,8.91,5,7.2,10,0.09,52,177,4,22,0,"#6366F1"]
  ];

  // Unified Periodic Table Registry (1-indexed: ELEMENTS[1]..ELEMENTS[118])
  const ELEMENTS = new Array(119);
  const ELEMENT_KEY_BY_Z = new Array(119);
  const Z_BY_ELEMENT_KEY = Object.create(null);

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  for (let i = 0; i < RAW_ELEMENTS.length; i++) {
    const r = RAW_ELEMENTS[i];
    const Z = r[0];
    const key = "upcs_" + r[1].toLowerCase();
    const isMetal = r[4] === "AM" || r[4] === "AE" || r[4] === "TM" || r[4] === "PT" || r[4] === "LN" || r[4] === "AN";
    const isCatalyst = r[4] === "TM" && (Z >= 23 && Z <= 29 || Z >= 41 && Z <= 47 || Z >= 73 && Z <= 79);
    const rgb = hexToRgb(r[19]);
    ELEMENTS[Z] = {
      Z,
      key,
      symbol: r[1],
      base_name: r[2],
      default_mass_number: r[3],
      periodic_group: r[4],
      isMetal,
      isCatalyst,
      valence_slots: r[5],
      valence_electrons: r[6],
      chi_EN: r[7],
      r_cov: r[8] / 100, // Angstroms
      ionization_energy: r[9],
      D_AA: r[10],       // kJ/mol
      rho_0: r[11] * 1000, // kg/m^3
      K_bulk: r[12] * 1e9, // Pa
      C_v: r[13] * 1000,   // J/(kg*K)
      melting_point: r[14],// C
      boiling_point: r[15],// C
      latent_heat_fus: r[16] * 1000 / r[3] * 1000, // J/kg approx
      latent_heat_vap: r[17] * 1000 / r[3] * 1000, // J/kg approx
      curie_temp: r[18],   // K (0 = non-ferromagnetic)
      base_color: r[19],
      rgb
    };
    ELEMENT_KEY_BY_Z[Z] = key;
    Z_BY_ELEMENT_KEY[key] = Z;
  }

  // ==========================================================================
  // 3. TWO-TIER HYBRID CACHING & FIRST-PRINCIPLES ANALYTICAL ENGINE
  // ==========================================================================
  const MAX_LRU = 4096;
  const bondCache = new Map();
  const isoCache = new Map();
  const thermoCache = new Map();

  // Precomputed 512-entry Blackbody LUT (800 K to 40,000 K, log-spaced)
  const BB_LUT_SIZE = 512;
  const BB_MIN_K = 800;
  const BB_MAX_K = 40000;
  const BB_LOG_MIN = Math.log(BB_MIN_K);
  const BB_LOG_SPAN = Math.log(BB_MAX_K) - BB_LOG_MIN;
  const BLACKBODY_LUT = new Uint8Array(BB_LUT_SIZE * 3);

  function computeBlackbodyRGB(tempK) {
    // Tanner Helland / physical Planckian fit
    const t = Math.max(800, Math.min(40000, tempK)) / 100;
    let r, g, b;
    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(Math.max(1, t)) - 161.1195681661;
      b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      b = 255;
    }
    return [
      Math.max(0, Math.min(255, r | 0)),
      Math.max(0, Math.min(255, g | 0)),
      Math.max(0, Math.min(255, b | 0))
    ];
  }

  for (let i = 0; i < BB_LUT_SIZE; i++) {
    const tempK = Math.exp(BB_LOG_MIN + (i / (BB_LUT_SIZE - 1)) * BB_LOG_SPAN);
    const [r, g, b] = computeBlackbodyRGB(tempK);
    BLACKBODY_LUT[i * 3] = r;
    BLACKBODY_LUT[i * 3 + 1] = g;
    BLACKBODY_LUT[i * 3 + 2] = b;
  }

  function queryBlackbodyLUT(tempK, out) {
    if (tempK < BB_MIN_K) { out[0] = 0; out[1] = 0; out[2] = 0; return 0; }
    const u = Math.max(0, Math.min(1, (Math.log(tempK) - BB_LOG_MIN) / BB_LOG_SPAN));
    const idx = ((u * (BB_LUT_SIZE - 1)) | 0) * 3;
    out[0] = BLACKBODY_LUT[idx];
    out[1] = BLACKBODY_LUT[idx + 1];
    out[2] = BLACKBODY_LUT[idx + 2];
    return Math.min(1, (tempK - BB_MIN_K) / 1400);
  }

  // Canonical Zero-String-Allocation Integer Keys
  function makeBondKey(zA, zB, order) {
    const lo = zA < zB ? zA : zB;
    const hi = zA < zB ? zB : zA;
    return ((lo & 0xFF) << 16) | ((hi & 0xFF) << 8) | (order & 0x0F);
  }

  function makeIsoKey(Z, A, isMeta) {
    return ((Z & 0xFF) << 12) | ((A & 0x3FF) << 1) | (isMeta ? 1 : 0);
  }

  function lruSet(map, key, val) {
    if (map.size >= MAX_LRU) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    map.set(key, val);
  }

  // Special Named Isotopes
  const SPECIAL_ISO_NAMES = {
    [makeIsoKey(1, 1, false)]: "Hydrogen-1 (Protium)",
    [makeIsoKey(1, 2, false)]: "Hydrogen-2 (Deuterium)",
    [makeIsoKey(1, 3, false)]: "Hydrogen-3 (Tritium)",
    [makeIsoKey(2, 3, false)]: "Helium-3"
  };

  function getIsotopeDisplayName(Z, A, isMeta) {
    const k = makeIsoKey(Z, A, !!isMeta);
    if (SPECIAL_ISO_NAMES[k]) return SPECIAL_ISO_NAMES[k];
    const el = ELEMENTS[Z];
    if (!el) return `Element-${Z}-${A}`;
    return `${el.base_name}-${A}${isMeta ? "m" : ""}`;
  }

  // --- Tier 2 Analytical Chemical Bond Solver ---
  function solveBondFirstPrinciples(zA, zB, order) {
    const eA = ELEMENTS[zA];
    const eB = ELEMENTS[zB];
    const dChi = Math.abs(eA.chi_EN - eB.chi_EN);
    let type = "nonpolar";
    if (eA.isMetal && eB.isMetal) type = "metallic";
    else if (dChi > 1.7) type = "ionic";
    else if (dChi > 0.4) type = "polar";

    const orderFactor = order === 3 ? 0.78 : order === 2 ? 0.87 : 1.00;
    const orderMult = order === 3 ? 2.15 : order === 2 ? 1.62 : 1.00;

    // Schomaker-Stevenson equilibrium length (Angstroms -> normalized grid length ~1.15 cells)
    const r0_A = Math.max(0.55, (eA.r_cov + eB.r_cov - 0.09 * dChi) * orderFactor);
    const restLength = Math.max(0.95, Math.min(1.65, 0.85 + r0_A * 0.22));

    // Pauling electronegativity bond dissociation energy (kJ/mol)
    const dBase = Math.sqrt(Math.max(1, eA.D_AA) * Math.max(1, eB.D_AA));
    const D0_kJ = (dBase + 96.485 * dChi * dChi) * orderMult;

    // Badger's rule spring stiffness (scaled for stable 2D voxel springs)
    const k_bond = Math.min(42, Math.max(3.5, (18.0 * order) / Math.pow(Math.max(0.45, r0_A - 0.35), 2.1)));

    // Evans-Polanyi activation barrier baseline (kJ/mol)
    const Ea_kJ = Math.max(15, 0.32 * D0_kJ);

    return {
      type,
      order,
      r0_A,
      restLength,
      breakEnergy: D0_kJ, // kJ/mol
      k_bond,
      Ea_kJ,
      source: "SOLVED"
    };
  }

  function getBondParams(zA, zB, order = 1) {
    const key = makeBondKey(zA, zB, order);
    const hit = bondCache.get(key);
    if (hit) return hit;
    const solved = solveBondFirstPrinciples(zA, zB, order);
    lruSet(bondCache, key, solved);
    return solved;
  }

  // --- Tier 2 Analytical Isotope & Nuclear Stability Solver (Bethe-Weizsäcker) ---
  function bindingEnergyMeV(Z, A) {
    if (A <= 1 || Z < 0 || Z > A) return 0;
    if (Z === 1 && A === 2) return 2.224;
    if (Z === 1 && A === 3) return 8.482;
    if (Z === 2 && A === 3) return 7.718;
    if (Z === 2 && A === 4) return 28.296;
    const N = A - Z;
    const av = 15.75, as = 17.8, ac = 0.711, aa = 23.7, ap = 11.18;
    let delta = 0;
    if ((Z & 1) === 0 && (N & 1) === 0) delta = ap / Math.sqrt(A);
    else if ((Z & 1) === 1 && (N & 1) === 1) delta = -ap / Math.sqrt(A);
    return av * A - as * Math.pow(A, 2 / 3) - ac * Z * (Z - 1) / Math.pow(A, 1 / 3) - aa * (A - 2 * Z) * (A - 2 * Z) / A + delta;
  }

  function solveIsotopeFirstPrinciples(Z, A, isMeta) {
    const B = bindingEnergyMeV(Z, A);
    const mExcess = (A - Z) * 8.071 + Z * 7.289 - B; // rough mass excess MeV

    // Check metastable isometric transition
    if (isMeta) {
      return {
        Z, A, isMeta: true,
        stable: false,
        decayMode: "IT (γ)",
        halfLifeSec: 21600,
        Q_MeV: 0.14,
        daughterZ: Z, daughterA: A, daughterMeta: false,
        sigmaFissionThermal: 0, sigmaFissionFast: 0, sigmaCapture: 0.2,
        isModerator: false, isControlAbsorber: false,
        B_per_A: A > 0 ? B / A : 0,
        source: "SOLVED"
      };
    }

    // Drip lines
    if (A < Z || Z < 1) {
      return { Z, A, stable: false, decayMode: "p-drip", halfLifeSec: 1e-18, Q_MeV: 2, daughterZ: Math.max(1, Z - 1), daughterA: Math.max(1, A - 1), daughterMeta: false, sigmaFissionThermal: 0, sigmaFissionFast: 0, sigmaCapture: 0, isModerator: false, isControlAbsorber: false, B_per_A: 0, source: "SOLVED" };
    }

    // Compare neighbor Q-values (beta-, beta+/EC, alpha)
    const Q_betaM = (Z + 1 <= 118) ? (bindingEnergyMeV(Z + 1, A) - B + 0.782) : -99;
    const Q_betaP = (Z - 1 >= 1)   ? (bindingEnergyMeV(Z - 1, A) - B - 0.782) : -99;
    const Q_alpha = (Z >= 60 && A > 120) ? (bindingEnergyMeV(Z - 2, A - 4) + 28.296 - B) : -99;
    const Q_sf    = (Z >= 92 && (Z * Z / A) > 36) ? 180 : -99;

    // Band of stability check
    const N = A - Z;
    const N_opt = Z * (1 + 0.015 * Math.pow(A, 2 / 3));
    const isNearDefault = Math.abs(A - (ELEMENTS[Z] ? ELEMENTS[Z].default_mass_number : A)) <= 1 && Z <= 82 && Z !== 43 && Z !== 61;

    let stable = isNearDefault && Q_betaM <= 0.3 && Q_betaP <= 0.3 && Q_alpha <= 2.5;
    let decayMode = "Stable";
    let halfLifeSec = Infinity;
    let Q_MeV = 0;
    let dZ = Z, dA = A;

    if (!stable) {
      if (Q_sf > 0 && Z >= 98 && (Z * Z / A) > 39.5) {
        decayMode = "SF";
        Q_MeV = 200;
        halfLifeSec = Math.pow(10, Math.max(-4, 10 - (Z - 98) * 1.4));
        dZ = (Z / 2) | 0; dA = (A / 2) | 0;
      } else if (Q_alpha > 3.5 && (Z > 82 || Q_alpha > Math.max(Q_betaM, Q_betaP))) {
        decayMode = "α";
        Q_MeV = Q_alpha;
        // Geiger-Nuttall approximation
        halfLifeSec = Math.pow(10, Math.max(-6, Math.min(18, 1.61 * Z / Math.sqrt(Math.max(1, Q_alpha)) - 42)));
        dZ = Z - 2; dA = A - 4;
      } else if (Q_betaM > 0 && N > N_opt - 0.5) {
        decayMode = "β⁻";
        Q_MeV = Q_betaM;
        // Sargent law t1/2 ~ Q^-5
        halfLifeSec = Math.max(0.01, Math.min(1e12, 1e4 / Math.pow(Math.max(0.2, Q_betaM), 4.2)));
        dZ = Z + 1; dA = A;
      } else if (Q_betaP > 0) {
        decayMode = "β⁺/EC";
        Q_MeV = Q_betaP;
        halfLifeSec = Math.max(0.01, Math.min(1e12, 1.5e4 / Math.pow(Math.max(0.2, Q_betaP), 4.0)));
        dZ = Z - 1; dA = A;
      } else {
        stable = true;
      }
    }

    const oddN = ((A - Z) & 1) === 1;
    const sigmaFissionThermal = (Z >= 90 && oddN && A >= 229) ? 450 : 0;
    const sigmaFissionFast = (Z >= 90) ? 1.5 : 0;
    const sigmaCapture = (Z >= 90 && !oddN) ? 3.0 : (Z === 5 && A === 10) ? 3840 : (Z === 48) ? 2500 : (Z === 72) ? 104 : 0.15;

    return {
      Z, A, isMeta: false,
      stable, decayMode, halfLifeSec, Q_MeV,
      daughterZ: dZ, daughterA: dA, daughterMeta: false,
      sigmaFissionThermal, sigmaFissionFast, sigmaCapture,
      isModerator: (Z === 1 || Z === 6 || Z === 8 || Z === 4),
      isControlAbsorber: (Z === 5 && A === 10) || Z === 48 || Z === 72 || Z === 64,
      B_per_A: A > 0 ? B / A : 0,
      mExcess,
      source: "SOLVED"
    };
  }

  function getIsotopeParams(Z, A, isMeta = false) {
    const key = makeIsoKey(Z, A, !!isMeta);
    const hit = isoCache.get(key);
    if (hit) return hit;
    const solved = solveIsotopeFirstPrinciples(Z, A, !!isMeta);
    lruSet(isoCache, key, solved);
    return solved;
  }

  // Tier 1 Startup Pre-Warming (Common Bonds & Curated Nuclear Isotopes)
  function prewarmCaches() {
    const curatedBonds = [
      [1,1,1,"nonpolar",1.00,436,22,120],
      [1,8,1,"polar",1.05,463,26,110],
      [6,1,1,"nonpolar",1.10,413,21,130],
      [6,6,1,"nonpolar",1.18,348,18,125],
      [6,6,2,"nonpolar",1.08,614,28,150],
      [6,6,3,"nonpolar",1.00,839,36,190],
      [6,8,1,"polar",1.14,358,20,115],
      [6,8,2,"polar",1.04,799,34,170],
      [7,7,3,"nonpolar",0.98,945,40,260],
      [8,8,2,"nonpolar",1.04,498,25,135],
      [11,17,1,"ionic",1.32,411,14,45],
      [26,26,1,"metallic",1.22,118,12,40],
      [14,8,1,"polar",1.18,452,24,135]
    ];
    for (const [zA, zB, order, type, restLength, breakEnergy, k_bond, Ea_kJ] of curatedBonds) {
      bondCache.set(makeBondKey(zA, zB, order), {
        type, order, r0_A: restLength, restLength, breakEnergy, k_bond, Ea_kJ, source: "CACHE"
      });
    }

    const curatedIsos = [
      // [Z, A, meta, stable, mode, t1/2(s), Q, dZ, dA, dMeta, sigFTh, sigFFast, sigCap, mod, ctrl]
      [1,1,false,true,"Stable",Infinity,0,1,1,false,0,0,0.33,true,false],
      [1,2,false,true,"Stable",Infinity,0,1,2,false,0,0,0.0005,true,false],
      [1,3,false,false,"β⁻",3.888e8,0.0186,2,3,false,0,0,0,true,false],
      [2,3,false,true,"Stable",Infinity,0,2,3,false,0,0,5330,false,false],
      [2,4,false,true,"Stable",Infinity,0,2,4,false,0,0,0,false,false],
      [5,10,false,true,"Stable",Infinity,0,5,10,false,0,0,3840,false,true],
      [6,12,false,true,"Stable",Infinity,0,6,12,false,0,0,0.0035,true,false],
      [6,14,false,false,"β⁻",1.808e11,0.156,7,14,false,0,0,0,true,false],
      [43,99,true,false,"IT (γ)",21624,0.142,43,99,false,0,0,0,false,false],
      [90,232,false,false,"α",4.43e17,4.08,88,228,false,0,0.07,7.4,false,false],
      [92,233,false,false,"α",5.02e12,4.91,90,229,false,531,2.0,45,false,false],
      [92,235,false,false,"α",2.22e16,4.68,90,231,false,585,1.2,99,false,false],
      [92,238,false,false,"α",1.41e17,4.27,90,234,false,0,0.3,2.7,false,false],
      [92,239,false,false,"β⁻",1407,1.26,93,239,false,0,0,22,false,false],
      [93,239,false,false,"β⁻",203558,0.72,94,239,false,0,0,35,false,false],
      [94,239,false,false,"α",7.61e11,5.24,92,235,false,748,1.8,270,false,false]
    ];
    for (const c of curatedIsos) {
      isoCache.set(makeIsoKey(c[0], c[1], c[2]), {
        Z: c[0], A: c[1], isMeta: c[2], stable: c[3], decayMode: c[4], halfLifeSec: c[5],
        Q_MeV: c[6], daughterZ: c[7], daughterA: c[8], daughterMeta: c[9],
        sigmaFissionThermal: c[10], sigmaFissionFast: c[11], sigmaCapture: c[12],
        isModerator: c[13], isControlAbsorber: c[14],
        B_per_A: bindingEnergyMeV(c[0], c[1]) / c[1],
        source: "CACHE"
      });
    }
  }
  prewarmCaches();

  // Dynamic Thermodynamic & Opacity Fallback Solver
  function getThermoProps(Z, A, tempK, chi) {
    const el = ELEMENTS[Z];
    const phase = getVoxelPhase(el, tempK, chi);
    const key = (Z << 4) | phase;
    let base = thermoCache.get(key);
    if (!base) {
      // Dulong-Petit (3R/M) for solids/liquids, 3/2 R/M for monatomic gas/plasma
      const M_kg_mol = Math.max(0.001, A * 1e-3);
      const Cv_dp = (phase >= 2 ? 1.5 : 3.0) * PHYS.R_gas / M_kg_mol;
      const C_v = (el && el.C_v > 0 && phase === 0) ? el.C_v : Cv_dp;
      const K_bulk = (el && el.K_bulk > 0) ? el.K_bulk : (phase >= 2 ? 1e5 : 2e10);
      const kappa = phase === 3 ? 0.4 * (1 + Z * 0.15) : (phase === 2 ? 0.04 : 8.0);
      base = { C_v, K_bulk, kappa };
      lruSet(thermoCache, key, base);
    }
    return { phase, C_v: base.C_v, K_bulk: base.K_bulk * (1 + 0.5 * Math.max(0, chi - 1)), kappa: base.kappa * chi };
  }

  // Phase: 0=Solid, 1=Liquid, 2=Gas, 3=Plasma
  function getVoxelPhase(el, tempK, chi) {
    if (!el) return 2;
    const tempC = tempK - 273.15;
    // Clausius-Clapeyron pressure shift with compression
    const pShift = Math.max(0, chi - 1) * 420;
    const ionTempK = el.ionization_energy * 800; // plasma threshold
    if (tempK >= ionTempK) return 3;
    if (tempC >= el.boiling_point + pShift) return 2;
    if (tempC >= el.melting_point + pShift * 0.35) return 1;
    return 0;
  }

  // ==========================================================================
  // 4. SIMULATION STATE, COARSE FIELDS & GLOBAL CONSERVATION LEDGER
  // ==========================================================================
  let nextUid = 1;
  const UPCS = {
    CONFIG,
    ELEMENTS,
    ELEMENT_KEY_BY_Z,
    Z_BY_ELEMENT_KEY,
    bonds: [],               // Non-voxel edge list: { aUid, bUid, order, type, restLength, k_bond, breakEnergy, strain }
    bondCountByUid: new Map(),
    uidToPixel: new Map(),
    neutrons: [],            // { x, y, vx, vy, energy_eV, age }
    delayedNeutrons: [],     // { x, y, timer }
    photons: [],             // { x, y, vx, vy, energy, r, g, b, life }
    sparks: [],              // { x, y, vx, vy, life, color }
    blackHoles: [],          // { x, y, mass, Rs_cells, spin, px, py }

    // Coarse Grid Buffers (resized dynamically for pixelResizeTool.js compatibility)
    gridW: 0, gridH: 0, cw: 0, ch: 0, blockSize: 4,
    massGrid: null, phiGrid: null, gxGrid: null, gyGrid: null,
    pressGrid: null, bxGrid: null, byGrid: null,
    vxGrid: null, vyGrid: null, curlGrid: null,

    // Conservation Ledger
    ledger: {
      M_total: 0,
      E_thermal: 0, E_kinetic: 0, E_chemical: 0, E_nuclear: 0, E_grav: 0, E_radiated: 0,
      P_x: 0, P_y: 0, L_z: 0,
      lastTickMs: 0,
      voxelCount: 0,
      storedCount: 0
    },

    // Inspector State
    hoverX: -1, hoverY: -1,
    pinnedUid: null,
    pinnedCoord: null,

    // Public helpers
    getBondParams,
    getIsotopeParams,
    getIsotopeDisplayName,
    applyScalePreset
  };
  window.UPCS = UPCS;

  function ensureCoarseGrids() {
    const w = typeof width === "number" ? width : 100;
    const h = typeof height === "number" ? height : 100;
    const bs = CONFIG.coarseBlockSize;
    if (UPCS.gridW === w && UPCS.gridH === h && UPCS.blockSize === bs && UPCS.massGrid) return;
    UPCS.gridW = w;
    UPCS.gridH = h;
    UPCS.blockSize = bs;
    UPCS.cw = Math.max(2, Math.ceil(w / bs));
    UPCS.ch = Math.max(2, Math.ceil(h / bs));
    const n = UPCS.cw * UPCS.ch;
    UPCS.massGrid  = new Float64Array(n);
    UPCS.phiGrid   = new Float64Array(n);
    UPCS.gxGrid    = new Float32Array(n);
    UPCS.gyGrid    = new Float32Array(n);
    UPCS.pressGrid = new Float64Array(n);
    UPCS.bxGrid    = new Float32Array(n);
    UPCS.byGrid    = new Float32Array(n);
    UPCS.vxGrid    = new Float32Array(n);
    UPCS.vyGrid    = new Float32Array(n);
    UPCS.curlGrid  = new Float32Array(n);
  }

  function computeAutoDt(meters) {
    const m = Math.max(1e-12, meters);
    if (m <= SCALE_PRESETS[0].meters) return SCALE_PRESETS[0].autoDt;
    const last = SCALE_PRESETS[SCALE_PRESETS.length - 1];
    if (m >= last.meters) {
      return last.autoDt * Math.pow(m / last.meters, 0.75);
    }
    const logM = Math.log10(m);
    for (let i = 0; i < SCALE_PRESETS.length - 1; i++) {
      const a = SCALE_PRESETS[i], b = SCALE_PRESETS[i + 1];
      if (m >= a.meters && m <= b.meters) {
        const t = (logM - Math.log10(a.meters)) / Math.max(1e-9, Math.log10(b.meters) - Math.log10(a.meters));
        return Math.pow(10, Math.log10(a.autoDt) * (1 - t) + Math.log10(b.autoDt) * t);
      }
    }
    return 1e-2;
  }

  function onScaleChanged() {
    // Wipe stale gravity & pressure potentials from the previous scale
    if (UPCS.phiGrid) UPCS.phiGrid.fill(0);
    if (UPCS.gxGrid) UPCS.gxGrid.fill(0);
    if (UPCS.gyGrid) UPCS.gyGrid.fill(0);
    if (UPCS.pressGrid) UPCS.pressGrid.fill(0);
    // Rescale Schwarzschild radii of any existing Black Hole voxels
    if (typeof currentPixels !== "undefined" && Array.isArray(currentPixels)) {
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (p && !p.del && p.isBlackHole) {
          p.Rs_cells = computeBlackHoleRsCells(p.bhMass);
        }
      }
    }
    syncConfigUI();
  }

  function applyScalePreset(presetId) {
    const p = SCALE_PRESETS.find(s => s.id === presetId);
    if (!p) return;
    CONFIG.scalePreset = p.id;
    CONFIG.voxelSizeMeters = p.meters;
    CONFIG.isAtomicMode = p.isAtomic;
    if (CONFIG.autoDt) CONFIG.dtSim = p.autoDt;
    onScaleChanged();
  }

  function applyCustomVoxelSize(meters) {
    if (!Number.isFinite(meters) || meters <= 0) return;
    CONFIG.scalePreset = "custom";
    CONFIG.voxelSizeMeters = Math.max(1e-11, Math.min(1e12, meters));
    CONFIG.isAtomicMode = CONFIG.voxelSizeMeters <= 5e-10;
    if (CONFIG.autoDt) CONFIG.dtSim = computeAutoDt(CONFIG.voxelSizeMeters);
    onScaleChanged();
  }

  function getCellVolume() {
    const L = CONFIG.voxelSizeMeters;
    return L * L * L;
  }

  function getRestMassKg(Z, A) {
    if (CONFIG.isAtomicMode || CONFIG.voxelSizeMeters <= 5e-10) {
      return A * PHYS.amu;
    }
    const el = ELEMENTS[Z];
    if (!el) return A * PHYS.amu;
    const isoScale = A / Math.max(1, el.default_mass_number);
    return Math.max(1e-30, el.rho_0 * isoScale * getCellVolume());
  }

  function getTotalMassKg(p) {
    if (p.isBlackHole) return Math.max(1e-30, p.bhMass || getDefaultBlackHoleMass());
    let m = getRestMassKg(p.Z, p.A);
    if (p.stored_voxels && p.stored_voxels.length > 0) {
      for (let i = 0; i < p.stored_voxels.length; i++) {
        const sv = p.stored_voxels[i];
        m += getRestMassKg(sv.Z, sv.A);
      }
    }
    return m;
  }

  function getDefaultBlackHoleMass() {
    if (CONFIG.voxelSizeMeters >= 1e3) return 3.0 * PHYS.M_sun;
    return Math.max(getRestMassKg(26, 56) * 40, 1e15);
  }

  function computeBlackHoleRsCells(massKg) {
    const L = CONFIG.voxelSizeMeters;
    const physicalRsCells = (2 * PHYS.G * massKg) / (PHYS.c * PHYS.c * Math.max(1e-10, L));
    if (!CONFIG.sandboxScaledAstro && physicalRsCells >= 0.8) {
      return Math.min(14, physicalRsCells);
    }
    const refMass = getDefaultBlackHoleMass();
    const ratio = Math.max(0.25, massKg / Math.max(1e-30, refMass));
    return Math.max(1.1, Math.min(12, 1.25 * Math.pow(ratio, 0.35) + Math.min(6, physicalRsCells)));
  }

  function initBlackHoleVoxel(p, massKg, opts = {}) {
    p._uid = p._uid || (nextUid++);
    p.Z = 0;
    p.A = 0;
    p.is_metastable = false;
    p.isUPCS = true;
    p.isBlackHole = true;
    p.remnant = "bh";
    p.bhMass = (massKg && massKg > 0) ? massKg : (p.bhMass || getDefaultBlackHoleMass());
    p.Rs_cells = computeBlackHoleRsCells(p.bhMass);
    p.absorbedCount = opts.absorbedCount !== undefined ? opts.absorbedCount : (p.absorbedCount || 0);
    p.vx = opts.vx !== undefined ? opts.vx : (p.vx || 0);
    p.vy = opts.vy !== undefined ? opts.vy : (p.vy || 0);
    p.ox = opts.ox !== undefined ? opts.ox : (p.ox || 0);
    p.oy = opts.oy !== undefined ? opts.oy : (p.oy || 0);
    p.chi = 1e6;
    p.charge = 0;
    p.mx = 0;
    p.my = 0;
    p.latent_buf = 0;
    p.stored_voxels = [];
    p.spin = opts.spin !== undefined ? opts.spin : (p.spin || 0);
    p.B_mag = 0;
    p.temp = -273.15;
    p.color = "#000000";
  }

  function collapseVoxelToBlackHole(p, bhMass) {
    const saved = {
      _uid: p._uid,
      vx: p.vx || 0,
      vy: p.vy || 0,
      ox: p.ox || 0,
      oy: p.oy || 0,
      spin: p.spin || 0,
      absorbedCount: 1 + (p.stored_voxels ? p.stored_voxels.length : 0)
    };
    if (p.element !== "upcs_black_hole" && typeof changePixel === "function") {
      changePixel(p, "upcs_black_hole", false);
    } else {
      p.element = "upcs_black_hole";
    }
    initBlackHoleVoxel(p, bhMass, saved);
  }

  function absorbVoxelIntoBlackHole(bh, victim) {
    if (!bh || !victim || bh === victim || bh.del || victim.del) return;
    const m0 = Math.max(1e-30, bh.bhMass || getDefaultBlackHoleMass());
    const mAbs = victim.isUPCS ? getTotalMassKg(victim) : getRestMassKg(14, 28);
    const mNew = m0 + mAbs;
    const vvx = victim.vx || 0;
    const vvy = victim.vy || 0;
    bh.vx = (m0 * (bh.vx || 0) + mAbs * vvx) / mNew;
    bh.vy = (m0 * (bh.vy || 0) + mAbs * vvy) / mNew;
    const dx = (victim.x + (victim.ox || 0)) - (bh.x + (bh.ox || 0));
    const dy = (victim.y + (victim.oy || 0)) - (bh.y + (bh.oy || 0));
    bh.spin = (bh.spin || 0) + (dx * (vvy - bh.vy) - dy * (vvx - bh.vx)) * (mAbs / mNew) * 0.5;
    if (victim.isBlackHole) bh.spin += (victim.spin || 0);
    bh.bhMass = mNew;
    bh.absorbedCount = (bh.absorbedCount || 0) + (victim.isBlackHole ? (victim.absorbedCount || 1) : (1 + (victim.stored_voxels ? victim.stored_voxels.length : 0)));
    bh.Rs_cells = computeBlackHoleRsCells(bh.bhMass);
    if (typeof deletePixel === "function") deletePixel(victim.x, victim.y);
    else victim.del = true;
  }

  // Initialize UPCS physics properties on a Sandboxels pixel (100% JSON-serializable)
  function initVoxel(p, Z) {
    const el = ELEMENTS[Z];
    p._uid = p._uid || (nextUid++);
    p.Z = Z;
    p.A = (CONFIG.brushIsotopeA && CONFIG.brushIsotopeA >= Z) ? CONFIG.brushIsotopeA : el.default_mass_number;
    p.is_metastable = !!CONFIG.brushMetastable;
    p.vx = p.vx || 0;
    p.vy = p.vy || 0;
    p.ox = p.ox || 0;
    p.oy = p.oy || 0;
    p.chi = p.chi || 1.0;
    p.charge = p.charge !== undefined ? p.charge : CONFIG.brushCharge;
    p.mx = p.mx !== undefined ? p.mx : (el.curie_temp > 0 ? CONFIG.brushDipole : 0);
    p.my = p.my || 0;
    p.latent_buf = p.latent_buf || 0;
    p.stored_voxels = Array.isArray(p.stored_voxels) ? p.stored_voxels : [];
    p.remnant = p.remnant || null; // null | "wd" | "bd" | "ns" | "bh"
    p.spin = p.spin || 0;
    p.B_mag = p.B_mag || 0;
    p.isBlackHole = false;
    p.isUPCS = true;
  }

  function mutateVoxelElement(p, newZ, newA, newMeta) {
    newZ = Math.max(1, Math.min(118, newZ | 0));
    newA = Math.max(newZ, Math.min(350, newA | 0));
    const newKey = ELEMENT_KEY_BY_Z[newZ];
    if (!newKey) return;
    const saved = {
      _uid: p._uid, vx: p.vx, vy: p.vy, ox: p.ox, oy: p.oy,
      chi: p.chi, charge: p.charge, mx: p.mx, my: p.my,
      latent_buf: p.latent_buf, stored_voxels: p.stored_voxels,
      remnant: p.remnant, spin: p.spin, B_mag: p.B_mag, temp: p.temp
    };
    if (p.element !== newKey && typeof changePixel === "function") {
      changePixel(p, newKey, false);
    }
    p.Z = newZ;
    p.A = newA;
    p.is_metastable = !!newMeta;
    Object.assign(p, saved);
    p.isUPCS = true;
  }

  // ==========================================================================
  // 5. REGISTER ALL 118 PERIODIC TABLE ELEMENTS (+ BLACK HOLE) IN SANDBOXELS
  // ==========================================================================
  function registerPeriodicTable() {
    if (typeof elements === "undefined") return;
    for (let Z = 1; Z <= 118; Z++) {
      const el = ELEMENTS[Z];
      elements[el.key] = {
        name: `${el.base_name} (${el.symbol})`,
        color: el.base_color,
        category: "elements",
        state: el.boiling_point < 20 ? "gas" : el.melting_point < 20 ? "liquid" : "solid",
        density: Math.max(0.05, el.rho_0),
        temp: 20,
        conduct: el.isMetal ? 0.85 : 0.05,
        behavior: [
          "XX|XX|XX",
          "XX|XX|XX",
          "XX|XX|XX"
        ],
        tick: function (pixel) {
          if (!pixel.isUPCS) initVoxel(pixel, Z);
          // Fallback to light vanilla gravity only when continuous kinematics are disabled
          if (!CONFIG.enableKinematics && typeof behaviors !== "undefined") {
            const pK = (pixel.temp ?? 20) + 273.15;
            const ph = getVoxelPhase(el, pK, pixel.chi || 1);
            if (ph === 2 || ph === 3) behaviors.GAS(pixel);
            else if (ph === 1) behaviors.LIQUID(pixel);
            else behaviors.POWDER(pixel);
          }
        }
      };
    }

    elements["upcs_black_hole"] = {
      name: "Black Hole",
      color: "#000000",
      category: "elements",
      state: "solid",
      density: 1e18,
      temp: -273.15,
      conduct: 0,
      behavior: [
        "XX|XX|XX",
        "XX|XX|XX",
        "XX|XX|XX"
      ],
      tick: function (pixel) {
        if (!pixel.isUPCS || !pixel.isBlackHole) initBlackHoleVoxel(pixel);
      }
    };
  }
  registerPeriodicTable();

  // ==========================================================================
  // 6. COARSE-GRID POISSON GRAVITY, MAGNETISM & FLUID VORTICITY SOLVERS
  // ==========================================================================
  function solveCoarseFields(activePixels) {
    ensureCoarseGrids();
    const cw = UPCS.cw, ch = UPCS.ch, bs = UPCS.blockSize, n = cw * ch;
    const massG = UPCS.massGrid;
    const phiG = UPCS.phiGrid;
    const gxG = UPCS.gxGrid;
    const gyG = UPCS.gyGrid;
    const pressG = UPCS.pressGrid;
    const bxG = UPCS.bxGrid;
    const byG = UPCS.byGrid;
    const vxG = UPCS.vxGrid;
    const vyG = UPCS.vyGrid;
    const curlG = UPCS.curlGrid;

    massG.fill(0);
    pressG.fill(0);
    bxG.fill(CONFIG.externalBx);
    byG.fill(CONFIG.externalBy);
    vxG.fill(0);
    vyG.fill(0);

    const countG = new Uint16Array(n);
    const L = CONFIG.voxelSizeMeters;
    const Vcell = getCellVolume();

    // 1. Deposit total voxel mass (primary + stored_voxels), pressure, dipoles, velocity
    for (let i = 0; i < activePixels.length; i++) {
      const p = activePixels[i];
      if (!p || p.del || p.isBlackHole) continue;
      const cx = Math.min(cw - 1, (p.x / bs) | 0);
      const cy = Math.min(ch - 1, (p.y / bs) | 0);
      const idx = cy * cw + cx;
      const mTot = getTotalMassKg(p);
      massG[idx] += mTot;
      countG[idx]++;

      const tempK = Math.max(0.5, (p.temp ?? 20) + 273.15);
      const P = computeEoSPressure(p, mTot, tempK, Vcell);
      p._lastP = P;
      pressG[idx] += P;

      vxG[idx] += p.vx;
      vyG[idx] += p.vy;

      // Ferromagnetic & pulsar dipole deposition
      if (CONFIG.enableMagnetism) {
        const el = ELEMENTS[p.Z];
        if (el && el.curie_temp > 0 && tempK < el.curie_temp && (p.mx !== 0 || p.my !== 0)) {
          bxG[idx] += p.mx * 0.8;
          byG[idx] += p.my * 0.8;
        } else if (p.remnant === "ns" && p.B_mag > 0) {
          bxG[idx] += Math.cos(p.spin) * p.B_mag;
          byG[idx] += Math.sin(p.spin) * p.B_mag;
        }
      }
    }

    const tileCells = bs * bs;
    for (let i = 0; i < n; i++) {
      if (countG[i] > 0) {
        vxG[i] /= countG[i];
        vyG[i] /= countG[i];
      }
      // Tile-averaged pressure proportional to local number density (so dense walls push back!)
      pressG[i] /= tileCells;
    }

    // Gentle reflecting-boundary smoothing pass on pressG to eliminate coarse-grid stair-stepping
    const pSmooth = new Float64Array(n);
    for (let y = 0; y < ch; y++) {
      const yU = y > 0 ? y - 1 : 0;
      const yD = y < ch - 1 ? y + 1 : ch - 1;
      for (let x = 0; x < cw; x++) {
        const xL = x > 0 ? x - 1 : 0;
        const xR = x < cw - 1 ? x + 1 : cw - 1;
        const idx = y * cw + x;
        pSmooth[idx] = 0.6 * pressG[idx] + 0.1 * (pressG[y * cw + xL] + pressG[y * cw + xR] + pressG[yU * cw + x] + pressG[yD * cw + x]);
      }
    }
    pressG.set(pSmooth);

    // 2. Gauss-Seidel Poisson Solver: ∇²Φ = 4π G ρ (dimensionally consistent cells/tick^2)
    if (CONFIG.enableGravity) {
      const dt = Math.max(1e-15, CONFIG.dtSim);
      // a_cells/tick^2 = (G * M / (r_cells^2 * L^2)) * (dt^2 / L) = G * M * dt^2 / (L^3 * r_cells^2)
      const effectiveScale = (4 * Math.PI * PHYS.G * dt * dt * CONFIG.gravityMultiplier) / Math.max(1e-36, Vcell * bs);

      for (let it = 0; it < CONFIG.poissonIterations; it++) {
        for (let y = 1; y < ch - 1; y++) {
          const row = y * cw;
          for (let x = 1; x < cw - 1; x++) {
            const idx = row + x;
            const rhs = massG[idx] * effectiveScale;
            phiG[idx] = 0.25 * (phiG[idx - 1] + phiG[idx + 1] + phiG[idx - cw] + phiG[idx + cw] - rhs);
          }
        }
      }

      // Compute acceleration g = -∇Φ across all tiles (one-sided at domain boundaries)
      for (let y = 0; y < ch; y++) {
        const yU = y > 0 ? y - 1 : 0;
        const yD = y < ch - 1 ? y + 1 : ch - 1;
        const dySpan = Math.max(1, yD - yU);
        const row = y * cw;
        for (let x = 0; x < cw; x++) {
          const xL = x > 0 ? x - 1 : 0;
          const xR = x < cw - 1 ? x + 1 : cw - 1;
          const dxSpan = Math.max(1, xR - xL);
          const idx = row + x;
          let gx = -((phiG[row + xR] - phiG[row + xL]) / dxSpan) / bs;
          let gy = -((phiG[yD * cw + x] - phiG[yU * cw + x]) / dySpan) / bs;
          // Clamp extreme singularities outside horizon
          const mag = Math.hypot(gx, gy);
          if (mag > 400) { gx = (gx / mag) * 400; gy = (gy / mag) * 400; }
          gxG[idx] = gx;
          gyG[idx] = gy;
        }
      }
    } else {
      phiG.fill(0);
      gxG.fill(0);
      gyG.fill(0);
    }

    // 3. Diffuse magnetic B field smoothly across coarse tiles
    if (CONFIG.enableMagnetism) {
      for (let pass = 0; pass < 3; pass++) {
        for (let y = 1; y < ch - 1; y++) {
          const row = y * cw;
          for (let x = 1; x < cw - 1; x++) {
            const idx = row + x;
            bxG[idx] = 0.6 * bxG[idx] + 0.1 * (bxG[idx - 1] + bxG[idx + 1] + bxG[idx - cw] + bxG[idx + cw]);
            byG[idx] = 0.6 * byG[idx] + 0.1 * (byG[idx - 1] + byG[idx + 1] + byG[idx - cw] + byG[idx + cw]);
          }
        }
      }
    }

    // 4. Vorticity Curl Field: ω = ∂vy/∂x - ∂vx/∂y
    if (CONFIG.enableVorticity) {
      curlG.fill(0);
      for (let y = 1; y < ch - 1; y++) {
        const row = y * cw;
        for (let x = 1; x < cw - 1; x++) {
          const idx = row + x;
          curlG[idx] = 0.5 * ((vyG[idx + 1] - vyG[idx - 1]) - (vxG[idx + cw] - vxG[idx - cw]));
        }
      }
    }
  }

  // Unified Equation of State: P_total = P_thermal + P_radiation + P_structural/degeneracy
  function computeEoSPressure(p, mTot, tempK, Vcell) {
    if (p.isBlackHole) return 0;
    const rho = mTot / Math.max(1e-36, Vcell);
    const chi = Math.max(1.0, p.chi || 1.0);
    const el = ELEMENTS[p.Z];
    const phase = getVoxelPhase(el, tempK, chi);

    // Solids are bound by lattice cohesion at chi=1; gases/plasmas exert full ideal-gas thermal pressure
    const mu = Math.max(0.5, p.A / Math.max(1, p.Z + 1));
    const P_ideal = (rho * PHYS.k_B * tempK) / (mu * PHYS.amu);
    const P_thermal = phase >= 2 ? P_ideal : (phase === 1 ? P_ideal * 0.08 : 0);

    const T2 = tempK * tempK;
    const P_rad = (1 / 3) * PHYS.a_rad * T2 * T2;

    let P_struct = 0;
    if (chi > 1.0) {
      // Switch to electron/neutron degeneracy pressure exponents at extreme compression
      let gamma = 1.6667; // 5/3 non-relativistic degeneracy
      if (chi > 12 || p.remnant === "wd") gamma = 1.3333; // 4/3 relativistic degeneracy
      if (p.remnant === "ns") gamma = 2.2; // strong-force repulsive nuclear stiffness
      const K = (el ? el.K_bulk : 1e9);
      P_struct = K * Math.pow(chi - 1.0, gamma);
    }
    return P_thermal + P_rad + P_struct;
  }

  function sampleCoarseBilinear(grid, gx, gy) {
    const bs = UPCS.blockSize;
    const fx = gx / bs - 0.5;
    const fy = gy / bs - 0.5;
    const x0 = Math.max(0, Math.min(UPCS.cw - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(UPCS.ch - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const i00 = y0 * UPCS.cw + x0;
    const v0 = grid[i00] * (1 - tx) + grid[i00 + 1] * tx;
    const v1 = grid[i00 + UPCS.cw] * (1 - tx) + grid[i00 + UPCS.cw + 1] * tx;
    return v0 * (1 - ty) + v1 * ty;
  }

  // ==========================================================================
  // 7. CHEMICAL BONDING GRAPH, SPRING FORCES & ENTHALPY ACCOUNTING
  // ==========================================================================
  function rebuildUidMap(activePixels) {
    UPCS.uidToPixel.clear();
    UPCS.bondCountByUid.clear();
    for (let i = 0; i < activePixels.length; i++) {
      const p = activePixels[i];
      UPCS.uidToPixel.set(p._uid, p);
    }
    // Prune orphaned bonds and recount valence occupancy
    for (let i = UPCS.bonds.length - 1; i >= 0; i--) {
      const b = UPCS.bonds[i];
      if (!UPCS.uidToPixel.has(b.aUid) || !UPCS.uidToPixel.has(b.bUid)) {
        UPCS.bonds.splice(i, 1);
        continue;
      }
      UPCS.bondCountByUid.set(b.aUid, (UPCS.bondCountByUid.get(b.aUid) || 0) + b.order);
      UPCS.bondCountByUid.set(b.bUid, (UPCS.bondCountByUid.get(b.bUid) || 0) + b.order);
    }
  }

  function hasBondBetween(u1, u2) {
    for (let i = 0; i < UPCS.bonds.length; i++) {
      const b = UPCS.bonds[i];
      if ((b.aUid === u1 && b.bUid === u2) || (b.aUid === u2 && b.bUid === u1)) return true;
    }
    return false;
  }

  function stepChemicalBonds(activePixels, subDt) {
    if (!CONFIG.enableBonding) return;

    // 1. Apply Hookean spring forces & test thermal/strain rupture
    for (let i = UPCS.bonds.length - 1; i >= 0; i--) {
      const b = UPCS.bonds[i];
      const pA = UPCS.uidToPixel.get(b.aUid);
      const pB = UPCS.uidToPixel.get(b.bUid);
      if (!pA || !pB) { UPCS.bonds.splice(i, 1); continue; }

      const dx = (pB.x + pB.ox) - (pA.x + pA.ox);
      const dy = (pB.y + pB.oy) - (pA.y + pA.oy);
      const dist = Math.hypot(dx, dy) || 1e-4;
      const stretch = dist - b.restLength;

      // Sever if crushed by extreme degeneracy or stretched/heated beyond breakEnergy
      const avgTempK = 0.5 * ((pA.temp ?? 20) + (pB.temp ?? 20)) + 273.15;
      const thermalKJ = (PHYS.R_gas * avgTempK) / 1000 * 6.0;
      const strainEnergy = 0.5 * b.k_bond * stretch * stretch * 45;
      b.strain = Math.min(1.5, (strainEnergy + thermalKJ) / Math.max(10, b.breakEnergy));

      if (b.strain >= 1.0 || dist > 4.2 || pA.chi > 6 || pB.chi > 6) {
        // Endothermic bond breaking: subtract dissociation enthalpy from local thermal energy
        const dT = Math.min(450, b.breakEnergy * 0.35);
        pA.temp = Math.max(-272, (pA.temp ?? 20) - dT);
        pB.temp = Math.max(-272, (pB.temp ?? 20) - dT);
        UPCS.ledger.E_chemical -= b.breakEnergy * 1e3;
        UPCS.ledger.E_thermal -= b.breakEnergy * 1e3;
        if (UPCS.sparks.length < 350) {
          UPCS.sparks.push({
            x: 0.5 * (pA.x + pB.x), y: 0.5 * (pA.y + pB.y),
            vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8,
            life: 1.0, color: "#FBBF24"
          });
        }
        UPCS.bonds.splice(i, 1);
        continue;
      }

      // Apply spring restoring force directly to continuous velocities
      const ux = dx / dist, uy = dy / dist;
      const fMag = b.k_bond * CONFIG.bondStiffnessScale * stretch;
      const mA = Math.max(1, pA.A), mB = Math.max(1, pB.A);
      const damp = 0.12 * ((pB.vx - pA.vx) * ux + (pB.vy - pA.vy) * uy);
      const totalF = fMag + damp;
      pA.vx += (totalF * ux / mA) * subDt * 6;
      pA.vy += (totalF * uy / mA) * subDt * 6;
      pB.vx -= (totalF * ux / mB) * subDt * 6;
      pB.vy -= (totalF * uy / mB) * subDt * 6;
    }

    // 2. Stochastic Bond Formation between adjacent unsaturated atoms (respecting Ea & Catalysts)
    if (UPCS.bonds.length > 6000) return;
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let i = 0; i < activePixels.length; i++) {
      if (Math.random() > 0.25) continue;
      const pA = activePixels[i];
      const elA = ELEMENTS[pA.Z];
      if (!elA || elA.valence_slots === 0 || pA.chi > 4) continue;
      const usedA = UPCS.bondCountByUid.get(pA._uid) || 0;
      const freeA = elA.valence_slots - usedA;
      if (freeA <= 0) continue;

      const d = dirs[(Math.random() * 4) | 0];
      const nx = pA.x + d[0], ny = pA.y + d[1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || !pixelMap[nx]) continue;
      const pB = pixelMap[nx][ny];
      if (!pB || !pB.isUPCS || pB.chi > 4) continue;
      const elB = ELEMENTS[pB.Z];
      if (!elB || elB.valence_slots === 0) continue;
      const usedB = UPCS.bondCountByUid.get(pB._uid) || 0;
      const freeB = elB.valence_slots - usedB;
      if (freeB <= 0 || hasBondBetween(pA._uid, pB._uid)) continue;

      // Determine best bond order (1, 2, or 3)
      let order = 1;
      if (freeA >= 3 && freeB >= 3 && (pA.Z === 6 || pA.Z === 7) && (pB.Z === 6 || pB.Z === 7)) order = 3;
      else if (freeA >= 2 && freeB >= 2 && (pA.Z === 6 || pA.Z === 8 || pA.Z === 7) && (pB.Z === 6 || pB.Z === 8 || pB.Z === 7)) order = 2;

      const bp = getBondParams(pA.Z, pB.Z, order);

      // Check adjacent transition metal catalyst lowering Ea
      let eaFactor = 1.0;
      if (CONFIG.enableCatalysts) {
        const cx = pA.x, cy = pA.y - 1;
        if (cy >= 0 && pixelMap[cx] && pixelMap[cx][cy] && pixelMap[cx][cy].isUPCS) {
          const catEl = ELEMENTS[pixelMap[cx][cy].Z];
          if (catEl && catEl.isCatalyst) eaFactor = 0.45;
        }
      }

      const relV2 = (pA.vx - pB.vx) ** 2 + (pA.vy - pB.vy) ** 2;
      const avgTempK = 0.5 * ((pA.temp ?? 20) + (pB.temp ?? 20)) + 273.15;
      const availableE = (PHYS.R_gas * avgTempK / 1000) * 14 + relV2 * 8;
      if (availableE >= bp.Ea_kJ * eaFactor * 0.22) {
        UPCS.bonds.push({
          aUid: pA._uid, bUid: pB._uid,
          order: bp.order, type: bp.type,
          restLength: bp.restLength, k_bond: bp.k_bond, breakEnergy: bp.breakEnergy,
          strain: 0
        });
        UPCS.bondCountByUid.set(pA._uid, usedA + order);
        UPCS.bondCountByUid.set(pB._uid, usedB + order);

        // Exothermic bond formation releases enthalpy as local heat
        const dT = Math.min(350, bp.breakEnergy * 0.28);
        pA.temp = (pA.temp ?? 20) + dT;
        pB.temp = (pB.temp ?? 20) + dT;
        UPCS.ledger.E_chemical += bp.breakEnergy * 1e3;
        UPCS.ledger.E_thermal += bp.breakEnergy * 1e3;
      }
    }
  }

  // ==========================================================================
  // 8. NUCLEAR FUSION, STELLAR EVOLUTION, DECAY & COMPACT REMNANTS
  // ==========================================================================
  function stepNuclearAndAstrophysics(activePixels) {
    const dt = CONFIG.dtSim;
    const L = CONFIG.voxelSizeMeters;
    const isStarScale = L >= 1e6; // True stellar scale (>= 1,000 km per voxel)

    // 1. Update Black Hole Voxels (Schwarzschild radius, horizon capture of vanilla pixels, Hawking evaporation)
    for (let i = UPCS.blackHoles.length - 1; i >= 0; i--) {
      const bh = UPCS.blackHoles[i];
      if (!bh || bh.del) { UPCS.blackHoles.splice(i, 1); continue; }
      bh.Rs_cells = computeBlackHoleRsCells(bh.bhMass);
      bh.temp = -273.15;

      // Capture any non-UPCS vanilla Sandboxels pixels that enter the event horizon
      const rInt = Math.ceil(bh.Rs_cells);
      const r2Max = bh.Rs_cells * bh.Rs_cells;
      for (let dx = -rInt; dx <= rInt; dx++) {
        for (let dy = -rInt; dy <= rInt; dy++) {
          if (dx === 0 && dy === 0) continue;
          if (dx * dx + dy * dy > r2Max) continue;
          const nx = bh.x + dx, ny = bh.y + dy;
          if (nx < 0 || nx > width || ny < 0 || ny > height) continue;
          const q = pixelMap[nx] && pixelMap[nx][ny];
          if (!q || q === bh || q.del) continue;
          if (q.isBlackHole) {
            // Merge smaller black hole into larger one
            if (bh.bhMass > q.bhMass || (bh.bhMass === q.bhMass && bh._uid < q._uid)) {
              absorbVoxelIntoBlackHole(bh, q);
            }
          } else {
            absorbVoxelIntoBlackHole(bh, q);
          }
        }
      }

      // Hawking evaporation (negligible for stellar BH, relevant only for tiny micro BH)
      const T_hawking = 1.227e23 / Math.max(1e5, bh.bhMass); // K
      if (T_hawking > 1e8 && bh.bhMass < 1e14) {
        const dM = Math.min(bh.bhMass * 0.02, 1e13 * Math.pow(1e12 / Math.max(1e5, bh.bhMass), 2) * dt);
        bh.bhMass -= dM;
        UPCS.ledger.E_radiated += dM * PHYS.c * PHYS.c;
        if (bh.bhMass <= 1e5) {
          if (typeof deletePixel === "function") deletePixel(bh.x, bh.y);
          else bh.del = true;
          UPCS.blackHoles.splice(i, 1);
          continue;
        }
      }
    }

    // 2. Per-Voxel Nuclear Reactions, Decay, Stellar Burning & Remnant Formation
    for (let i = 0; i < activePixels.length; i++) {
      const p = activePixels[i];
      if (!p || !p.isUPCS || p.del || p.isBlackHole) continue;
      const tempK = Math.max(0.5, (p.temp ?? 20) + 273.15);
      const chi = p.chi || 1.0;

      // Gentle shear heating only for fast-orbiting matter skimming close to a black hole
      for (let b = 0; b < UPCS.blackHoles.length; b++) {
        const bh = UPCS.blackHoles[b];
        if (!bh || bh.del) continue;
        const dx = (p.x + (p.ox || 0)) - (bh.x + (bh.ox || 0));
        const dy = (p.y + (p.oy || 0)) - (bh.y + (bh.oy || 0));
        const r = Math.hypot(dx, dy);
        if (r > bh.Rs_cells && r <= bh.Rs_cells * 2.5) {
          const rvx = (p.vx || 0) - (bh.vx || 0);
          const rvy = (p.vy || 0) - (bh.vy || 0);
          const tangV = Math.abs((-dy * rvx + dx * rvy) / Math.max(0.5, r));
          if (tangV > 0.6) {
            p.temp = Math.min(1e9, (p.temp ?? 20) + tangV * tangV * 120);
          }
        }
      }

      // --- Radioactive Decay (Isotope Flag Driven) ---
      if (CONFIG.enableDecay && Math.random() < 0.08) {
        const iso = getIsotopeParams(p.Z, p.A, p.is_metastable);
        if (!iso.stable && iso.halfLifeSec < 1e20) {
          const lambda = 0.693147 / Math.max(1e-6, iso.halfLifeSec);
          const prob = 1 - Math.exp(-lambda * Math.max(dt, 0.05) * 12);
          if (Math.random() < prob) {
            const heatDelta = Math.min(2500, iso.Q_MeV * 180);
            p.temp = (p.temp ?? 20) + heatDelta;
            UPCS.ledger.E_nuclear -= iso.Q_MeV * PHYS.MeV_to_J;
            UPCS.ledger.E_thermal += iso.Q_MeV * PHYS.MeV_to_J;
            if (iso.decayMode === "SF") {
              // Spontaneous fission emits prompt neutrons
              spawnNeutron(p.x, p.y, 2e6);
              spawnNeutron(p.x, p.y, 2e6);
              mutateVoxelElement(p, 36, 92, false);
            } else {
              mutateVoxelElement(p, iso.daughterZ, iso.daughterA, iso.daughterMeta);
            }
          }
        }
      }

      // --- Nuclear Fusion & Stellar Evolution (Emergent from T, chi, Z, A) ---
      if (CONFIG.enableFusion && tempK >= 1.5e6) {
        const rateMult = CONFIG.fusionRateMult * Math.min(10, chi);
        const Z = p.Z, A = p.A;

        // 1. D-T & D-D Low-Barrier Fusion (Hydrogen-2 / Hydrogen-3)
        if (Z === 1 && (A === 2 || A === 3) && tempK >= 1.5e6) {
          const prob = Math.min(0.35, 0.015 * rateMult * Math.pow(tempK / 1.5e7, 2));
          if (Math.random() < prob) {
            if (A === 3) {
              // D + T -> He-4 + 14.1 MeV fast neutron
              mutateVoxelElement(p, 2, 4, false);
              p.temp += 1.8e6;
              spawnNeutron(p.x, p.y, 1.41e7);
            } else {
              // D + D -> He-3 + n OR H-3 + p
              if (Math.random() < 0.5) { mutateVoxelElement(p, 2, 3, false); spawnNeutron(p.x, p.y, 2.45e6); }
              else { mutateVoxelElement(p, 1, 3, false); }
              p.temp += 8.5e5;
            }
            UPCS.ledger.E_nuclear -= 17.6 * PHYS.MeV_to_J;
            UPCS.ledger.E_thermal += 17.6 * PHYS.MeV_to_J;
          }
        }
        // 2. Main Sequence Hydrogen Burning (p-p Chain T >= 4e6 K & CNO Cycle T >= 1.5e7 K)
        else if (Z === 1 && A === 1 && tempK >= 4e6) {
          const hasCarbonNeighbor = hasNeighborZ(p.x, p.y, 6);
          const epsPP = 0.0008 * rateMult * Math.pow(tempK / 1.5e7, 4);
          const epsCNO = (hasCarbonNeighbor && tempK >= 1.5e7) ? 0.004 * rateMult * Math.pow(tempK / 2e7, 8) : 0;
          if (Math.random() < Math.min(0.18, epsPP + epsCNO)) {
            // Mutate H-1 -> H-2 -> He-3 -> He-4 progressively
            if (Math.random() < 0.45) mutateVoxelElement(p, 1, 2, false);
            else mutateVoxelElement(p, 2, 4, false);
            p.temp += 1.4e6;
            UPCS.ledger.E_nuclear -= 26.7 * PHYS.MeV_to_J;
            UPCS.ledger.E_thermal += 26.7 * PHYS.MeV_to_J;
            emitPhoton(p.x, p.y, tempK, 1.0);
          }
        }
        // 3. Helium Burning / Triple-Alpha Process (T >= 1e8 K) & Helium Flash
        else if (Z === 2 && A === 4 && tempK >= 1e8 && chi >= 1.8) {
          const flashBoost = chi > 4.0 ? 3.5 : 1.0; // Electron-degenerate Helium Flash
          const prob = Math.min(0.25, 0.004 * rateMult * flashBoost * Math.pow(tempK / 1e8, 5));
          if (Math.random() < prob) {
            mutateVoxelElement(p, 6, 12, false);
            p.temp += 3.5e6 * flashBoost;
            UPCS.ledger.E_nuclear -= 7.27 * PHYS.MeV_to_J;
            UPCS.ledger.E_thermal += 7.27 * PHYS.MeV_to_J;
          }
        }
        // 4. Carbon Burning (T >= 5e8 K): C-12 -> O-16 / Ne-20 / Mg-24
        else if (Z === 6 && tempK >= 5e8) {
          if (Math.random() < Math.min(0.22, 0.01 * rateMult)) {
            const r = Math.random();
            if (r < 0.35) mutateVoxelElement(p, 8, 16, false);
            else if (r < 0.72) mutateVoxelElement(p, 10, 20, false);
            else mutateVoxelElement(p, 12, 24, false);
            p.temp += 8e6;
          }
        }
        // 5. Neon Burning (T >= 1.2e9 K)
        else if (Z === 10 && tempK >= 1.2e9) {
          if (Math.random() < Math.min(0.25, 0.015 * rateMult)) {
            mutateVoxelElement(p, Math.random() < 0.5 ? 8 : 12, Math.random() < 0.5 ? 16 : 24, false);
            p.temp += 1.2e7;
          }
        }
        // 6. Oxygen Burning (T >= 1.5e9 K): O-16 -> Si-28 / S-32
        else if (Z === 8 && tempK >= 1.5e9) {
          if (Math.random() < Math.min(0.28, 0.02 * rateMult)) {
            if (Math.random() < 0.65) mutateVoxelElement(p, 14, 28, false);
            else mutateVoxelElement(p, 16, 32, false);
            p.temp += 2e7;
          }
        }
        // 7. Silicon Burning (T >= 2.7e9 K): Si-28 / S-32 / Mg-24 -> Fe-56 / Ni-56
        else if ((Z === 14 || Z === 16 || Z === 12) && tempK >= 2.7e9) {
          if (Math.random() < Math.min(0.32, 0.03 * rateMult)) {
            if (Math.random() < 0.6) mutateVoxelElement(p, 26, 56, false);
            else mutateVoxelElement(p, 28, 56, false);
            p.temp += 2.5e7;
          }
        }
        // 8. Core-Collapse Supernova: Endothermic Fe-56 / Ni-56 Photodisintegration (T >= 5e9 K)
        else if ((Z === 26 || Z === 28) && tempK >= 5e9 && chi >= 3.0) {
          triggerCoreCollapseBounce(p, activePixels);
        }
      }

      // --- Compact Remnant Thresholds (White Dwarf -> Black Dwarf, Neutron Star, Black Hole) ---
      const mTot = getTotalMassKg(p);
      const physRs = (2 * PHYS.G * mTot) / (PHYS.c * PHYS.c);
      const meetsPhysicalBH = (mTot >= PHYS.M_tov) || (physRs >= 0.5 * L);
      const storedN = p.stored_voxels ? p.stored_voxels.length : 0;

      if (meetsPhysicalBH) {
        collapseVoxelToBlackHole(p, mTot);
        UPCS.blackHoles.push(p);
        continue;
      }

      // Scaled stellar remnants ONLY apply at true stellar voxel scales (L >= 1,000 km)
      if (isStarScale && chi >= 6.0) {
        const effWD = CONFIG.sandboxScaledAstro ? 5e25 : PHYS.M_chandra * 0.5;
        const effNS = CONFIG.sandboxScaledAstro ? 1.8e26 : PHYS.M_chandra;
        const effBH = CONFIG.sandboxScaledAstro ? 4.5e26 : PHYS.M_tov;

        if (mTot >= effBH && storedN >= 32 && (p.remnant === "ns" || chi >= 18.0)) {
          // Collapse stellar core in-place into a deletable Black Hole voxel
          const bhMass = CONFIG.sandboxScaledAstro ? Math.max(mTot, 3.0 * PHYS.M_sun) : mTot;
          collapseVoxelToBlackHole(p, bhMass);
          UPCS.blackHoles.push(p);
          continue;
        } else if (mTot >= effNS && storedN >= 16 && chi >= 8.0) {
          if (p.remnant !== "ns") {
            p.remnant = "ns";
            p.spin = (p.spin || 0.2) * 12;   // Angular momentum conservation spin-up
            p.B_mag = Math.max(15, (p.B_mag || 1) * 20); // Flux conservation magnetar amplification
          }
          p.spin += 0.4;
        } else if ((p.Z === 6 || p.Z === 8 || p.Z === 2) && mTot >= effWD && storedN >= 6 && p.remnant !== "ns") {
          p.remnant = tempK < 900 ? "bd" : "wd";
        }
      }

      // Radiative Blackbody Cooling (enables White Dwarf -> Black Dwarf & stellar photosphere emission)
      if (CONFIG.enableRadiativeTransfer && tempK > 300) {
        const th = getThermoProps(p.Z, p.A, tempK, chi);
        // Check if exposed to vacuum/low-opacity neighbor
        const exposed = isExposedToEmpty(p.x, p.y);
        const radFactor = exposed ? (1.0 / Math.max(0.2, th.kappa)) : (0.04 / Math.max(1.0, th.kappa));
        const dT_rad = Math.min(tempK * 0.08, 1.2e-11 * Math.pow(tempK, 3.2) * radFactor);
        if (dT_rad > 0.05) {
          p.temp = Math.max(-270, (p.temp ?? 20) - dT_rad);
          UPCS.ledger.E_radiated += dT_rad * th.C_v * 0.01;
          if (exposed && tempK > 2500 && Math.random() < 0.04) {
            emitPhoton(p.x, p.y, tempK, 0.7);
          }
        }
      }
    }
  }

  function triggerCoreCollapseBounce(coreP, activePixels) {
    // Endothermic core collapse followed by incompressible bounce shockwave + r-process nucleosynthesis
    coreP.remnant = "ns";
    coreP.spin = 18;
    coreP.B_mag = 40;
    coreP.temp = 2e8;

    // Emit r-process neutron burst
    for (let k = 0; k < 14; k++) spawnNeutron(coreP.x, coreP.y, 4e6);

    // Outward radial shockwave + r-process heavy element synthesis
    for (let i = 0; i < activePixels.length; i++) {
      const q = activePixels[i];
      if (!q || q === coreP || q.del) continue;
      const dx = q.x - coreP.x, dy = q.y - coreP.y;
      const r2 = dx * dx + dy * dy;
      if (r2 > 0 && r2 < 400) {
        const r = Math.sqrt(r2);
        const impulse = 18 / (1 + r * 0.25);
        q.vx += (dx / r) * impulse;
        q.vy += (dy / r) * impulse;
        q.temp = Math.min(2e9, (q.temp ?? 20) + 1.5e7 / (1 + r * 0.3));
        // Rapid neutron capture (r-process) mutating heavy nuclei up to Uranium/Gold
        if (r < 8 && Math.random() < 0.22 && q.Z >= 20 && q.Z < 92) {
          const newZ = Math.min(94, q.Z + ((Math.random() * 48) | 0));
          mutateVoxelElement(q, newZ, ELEMENTS[newZ].default_mass_number, false);
        }
      }
    }
    emitPhoton(coreP.x, coreP.y, 35000, 1.5);
  }

  function hasNeighborZ(x, y, targetZ) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && pixelMap[nx] && pixelMap[nx][ny]) {
          if (pixelMap[nx][ny].Z === targetZ) return true;
        }
      }
    }
    return false;
  }

  function isExposedToEmpty(x, y) {
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (let i = 0; i < 4; i++) {
      const nx = x + dirs[i][0], ny = y + dirs[i][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return true;
      if (!pixelMap[nx] || !pixelMap[nx][ny]) return true;
    }
    return false;
  }

  // ==========================================================================
  // 9. SUB-GRID NEUTRON TRANSPORT & NUCLEAR FISSION
  // ==========================================================================
  function spawnNeutron(x, y, energy_eV = 2e6) {
    if (UPCS.neutrons.length >= 750) return;
    const ang = Math.random() * Math.PI * 2;
    const speed = energy_eV > 1e4 ? 2.4 : 0.85; // Fast vs Thermal velocity in cells/substep
    UPCS.neutrons.push({
      x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      energy_eV, age: 0
    });
  }

  function emitPhoton(x, y, tempK, life = 1.0) {
    if (UPCS.photons.length >= 550) return;
    const ang = Math.random() * Math.PI * 2;
    const rgb = [255, 255, 255];
    queryBlackbodyLUT(tempK, rgb);
    UPCS.photons.push({
      x, y, vx: Math.cos(ang) * 4.5, vy: Math.sin(ang) * 4.5,
      energy: tempK, r: rgb[0], g: rgb[1], b: rgb[2], life
    });
  }

  function stepNeutronsAndPhotons() {
    // 1. Delayed neutron emitters (~0.65% delayed fraction for stable reactor control)
    for (let i = UPCS.delayedNeutrons.length - 1; i >= 0; i--) {
      const dn = UPCS.delayedNeutrons[i];
      dn.timer -= 1;
      if (dn.timer <= 0) {
        spawnNeutron(dn.x, dn.y, 5e5);
        UPCS.delayedNeutrons.splice(i, 1);
      }
    }

    // 2. Sub-grid neutron transport with CFL-safe stepping
    if (CONFIG.enableFission) {
      for (let i = UPCS.neutrons.length - 1; i >= 0; i--) {
        const n = UPCS.neutrons[i];
        n.age++;
        if (n.age > 260) { UPCS.neutrons.splice(i, 1); continue; }

        // Step in two half-steps to avoid tunneling through thin rods
        let consumed = false;
        for (let s = 0; s < 2; s++) {
          n.x += n.vx * 0.5;
          n.y += n.vy * 0.5;
          const gx = Math.floor(n.x), gy = Math.floor(n.y);
          if (gx < 0 || gx >= width || gy < 0 || gy >= height) { consumed = true; break; }
          for (let b = 0; b < UPCS.blackHoles.length; b++) {
            const bh = UPCS.blackHoles[b];
            if (!bh || bh.del) continue;
            const bdx = n.x - (bh.x + (bh.ox || 0));
            const bdy = n.y - (bh.y + (bh.oy || 0));
            if (bdx * bdx + bdy * bdy <= bh.Rs_cells * bh.Rs_cells) { consumed = true; break; }
          }
          if (consumed) break;
          const p = pixelMap[gx] && pixelMap[gx][gy];
          if (!p || !p.isUPCS) continue;
          if (p.isBlackHole) { consumed = true; break; }

          const iso = getIsotopeParams(p.Z, p.A, p.is_metastable);
          const isThermal = n.energy_eV < 1.0;

          // Control Rod Absorption (Boron-10, Cadmium, Hafnium, Gadolinium)
          if (iso.isControlAbsorber && Math.random() < (isThermal ? 0.78 : 0.12)) {
            p.temp = (p.temp ?? 20) + 85;
            consumed = true;
            break;
          }

          // Elastic Moderation (Water / Heavy Water / Graphite slows fast neutrons -> thermal)
          if (iso.isModerator && !isThermal && Math.random() < 0.45) {
            n.energy_eV *= 0.04;
            const ang = Math.random() * Math.PI * 2;
            const spd = n.energy_eV < 1.0 ? 0.85 : 1.5;
            n.vx = Math.cos(ang) * spd;
            n.vy = Math.sin(ang) * spd;
            p.temp = (p.temp ?? 20) + 18;
            continue;
          }

          // Fission Cross-Section (U-235, Pu-239, U-233)
          const sigF = isThermal ? iso.sigmaFissionThermal : iso.sigmaFissionFast;
          if (sigF > 0 && Math.random() < Math.min(0.82, sigF * 0.0012)) {
            // Split nucleus into radioactive fission fragments (e.g., Kr-92 + Ba-141)
            const dZ1 = 36 + ((Math.random() * 6) | 0);
            const dA1 = Math.max(dZ1, Math.round(p.A * 0.39));
            const dZ2 = Math.max(1, p.Z - dZ1);
            const dA2 = Math.max(dZ2, p.A - dA1 - 2);
            mutateVoxelElement(p, dZ1, dA1, false);
            p.temp = (p.temp ?? 20) + 4200; // ~200 MeV fission kinetic heat

            // Recoil impulse
            const rAng = Math.random() * Math.PI * 2;
            p.vx += Math.cos(rAng) * 3.5;
            p.vy += Math.sin(rAng) * 3.5;

            // Spawn second fission daughter in adjacent empty cell if available
            const nx = p.x + (Math.cos(rAng) > 0 ? -1 : 1);
            const ny = p.y + (Math.sin(rAng) > 0 ? -1 : 1);
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && typeof isEmpty === "function" && isEmpty(nx, ny)) {
              createPixel(ELEMENT_KEY_BY_Z[dZ2], nx, ny);
              const q = pixelMap[nx][ny];
              if (q) {
                initVoxel(q, dZ2);
                q.A = dA2;
                q.temp = p.temp;
                q.vx = -Math.cos(rAng) * 3.5;
                q.vy = -Math.sin(rAng) * 3.5;
              }
            }

            // Emit ν ≈ 2.4–2.9 neutrons (99.35% prompt, 0.65% delayed)
            const nu = Math.random() < 0.55 ? 3 : 2;
            for (let k = 0; k < nu; k++) {
              if (Math.random() < 0.04) { // slightly boosted delayed fraction for visible reactor control
                UPCS.delayedNeutrons.push({ x: p.x, y: p.y, timer: 45 + ((Math.random() * 75) | 0) });
              } else {
                spawnNeutron(p.x, p.y, 2e6);
              }
            }

            UPCS.ledger.E_nuclear -= 200 * PHYS.MeV_to_J;
            UPCS.ledger.E_thermal += 200 * PHYS.MeV_to_J;
            emitPhoton(p.x, p.y, 18000, 0.9);
            consumed = true;
            break;
          }

          // Fertile Neutron Capture & Breeding (e.g., U-238 + n -> U-239 -> Np-239 -> Pu-239)
          if (iso.sigmaCapture > 0.5 && Math.random() < Math.min(0.25, iso.sigmaCapture * 0.015)) {
            p.A += 1;
            p.temp = (p.temp ?? 20) + 120;
            consumed = true;
            break;
          }
        }
        if (consumed) UPCS.neutrons.splice(i, 1);
      }
    }

    // 3. Sub-grid Photons & Sparks
    for (let i = UPCS.photons.length - 1; i >= 0; i--) {
      const ph = UPCS.photons[i];
      ph.x += ph.vx;
      ph.y += ph.vy;
      ph.life -= 0.045;
      // Check photon capture by black hole event horizons
      let swallowed = false;
      for (let b = 0; b < UPCS.blackHoles.length; b++) {
        const bh = UPCS.blackHoles[b];
        if (!bh || bh.del) continue;
        const dx = ph.x - (bh.x + (bh.ox || 0));
        const dy = ph.y - (bh.y + (bh.oy || 0));
        if (dx * dx + dy * dy <= bh.Rs_cells * bh.Rs_cells) { swallowed = true; break; }
      }
      if (swallowed || ph.life <= 0 || ph.x < 0 || ph.x >= width || ph.y < 0 || ph.y >= height) {
        UPCS.photons.splice(i, 1);
      }
    }
    for (let i = UPCS.sparks.length - 1; i >= 0; i--) {
      const sp = UPCS.sparks[i];
      sp.x += sp.vx * 0.12;
      sp.y += sp.vy * 0.12;
      sp.life -= 0.09;
      if (sp.life <= 0) UPCS.sparks.splice(i, 1);
    }
  }

  // ==========================================================================
  // 10. CONTINUOUS SUB-PIXEL KINEMATICS, COMPRESSION & stored_voxels STACKING
  // ==========================================================================
  function stepKinematicsSubstep(activePixels, subDt) {
    if (!CONFIG.enableKinematics) return;
    const bs = UPCS.blockSize;
    const cw = UPCS.cw, ch = UPCS.ch;
    const L = CONFIG.voxelSizeMeters;
    const Vcell = getCellVolume();
    const refBhMass = UPCS.blackHoles.length > 0 ? getDefaultBlackHoleMass() : 1;

    for (let i = 0; i < activePixels.length; i++) {
      const p = activePixels[i];
      if (!p || !p.isUPCS || p.del) continue;

      // Direct smooth softened 1/r^2 gravity & horizon absorption from Black Hole voxels
      let bhAx = 0, bhAy = 0;
      let absorbedByBh = false;
      if (UPCS.blackHoles.length > 0) {
        const px = p.x + (p.ox || 0);
        const py = p.y + (p.oy || 0);
        for (let b = 0; b < UPCS.blackHoles.length; b++) {
          const bh = UPCS.blackHoles[b];
          if (!bh || bh === p || bh.del) continue;
          const dx = (bh.x + (bh.ox || 0)) - px;
          const dy = (bh.y + (bh.oy || 0)) - py;
          const r2 = dx * dx + dy * dy;
          const r = Math.sqrt(r2);

          if (r <= bh.Rs_cells) {
            if (p.isBlackHole) {
              // Merge the less massive black hole into the more massive one
              if (bh.bhMass > p.bhMass || (bh.bhMass === p.bhMass && bh._uid < p._uid)) {
                absorbVoxelIntoBlackHole(bh, p);
                absorbedByBh = true;
                break;
              }
            } else {
              absorbVoxelIntoBlackHole(bh, p);
              absorbedByBh = true;
              break;
            }
          }

          if (CONFIG.enableGravity && r > 1e-4) {
            const massFactor = Math.pow(Math.max(0.1, (bh.bhMass || refBhMass) / Math.max(1e-30, refBhMass)), 0.5);
            const mu = 28.0 * massFactor * Math.max(0.1, CONFIG.gravityMultiplier);
            const eps = Math.max(0.9, (bh.Rs_cells || 1.25) * 0.65);
            const accel = Math.min(35.0, mu / (r2 + eps * eps));
            bhAx += (dx / r) * accel;
            bhAy += (dy / r) * accel;
          }
        }
      }
      if (absorbedByBh || p.del) continue;

      // Black Hole voxel kinematics: pure gravity + momentum conservation (no fluid pressure/drag/magnetic artifacts)
      if (p.isBlackHole) {
        let ax = bhAx, ay = bhAy;
        if (CONFIG.enableGravity) {
          ax += sampleCoarseBilinear(UPCS.gxGrid, p.x, p.y);
          ay += sampleCoarseBilinear(UPCS.gyGrid, p.x, p.y);
        }
        p.vx = (p.vx || 0) + ax * subDt;
        p.vy = (p.vy || 0) + ay * subDt;
        const maxV = CONFIG.cflMaxDisp / Math.max(1e-4, subDt);
        const vMag = Math.hypot(p.vx, p.vy);
        if (vMag > maxV) {
          const sc = maxV / vMag;
          p.vx *= sc;
          p.vy *= sc;
        }
        if (!Number.isFinite(p.vx)) p.vx = 0;
        if (!Number.isFinite(p.vy)) p.vy = 0;

        p.ox = (p.ox || 0) + p.vx * subDt;
        p.oy = (p.oy || 0) + p.vy * subDt;

        let stepX = 0, stepY = 0;
        if (p.ox >= 0.5) stepX = 1; else if (p.ox <= -0.5) stepX = -1;
        if (p.oy >= 0.5) stepY = 1; else if (p.oy <= -0.5) stepY = -1;

        if (stepX !== 0 || stepY !== 0) {
          const nx = p.x + stepX, ny = p.y + stepY;
          if (nx < 0 || nx > width || ny < 0 || ny > height) {
            if (nx < 0 || nx > width) { p.vx = -p.vx * 0.5; p.ox = Math.max(-0.49, Math.min(0.49, p.ox)); }
            if (ny < 0 || ny > height) { p.vy = -p.vy * 0.5; p.oy = Math.max(-0.49, Math.min(0.49, p.oy)); }
          } else if (typeof isEmpty === "function" && isEmpty(nx, ny)) {
            movePixel(p, nx, ny);
            p.ox -= stepX;
            p.oy -= stepY;
          } else {
            const target = pixelMap[nx] && pixelMap[nx][ny];
            if (target && target !== p && !target.del) {
              if (target.isBlackHole) {
                if (p.bhMass >= target.bhMass) {
                  absorbVoxelIntoBlackHole(p, target);
                  if (typeof isEmpty === "function" && isEmpty(nx, ny)) {
                    movePixel(p, nx, ny);
                    p.ox -= stepX;
                    p.oy -= stepY;
                  }
                } else {
                  absorbVoxelIntoBlackHole(target, p);
                }
              } else {
                absorbVoxelIntoBlackHole(p, target);
                if (typeof isEmpty === "function" && isEmpty(nx, ny)) {
                  movePixel(p, nx, ny);
                  p.ox -= stepX;
                  p.oy -= stepY;
                }
              }
            }
          }
        }
        continue;
      }

      const el = ELEMENTS[p.Z];
      const tempK = Math.max(0.5, (p.temp ?? 20) + 273.15);
      const mTot = getTotalMassKg(p);
      const mRest = getRestMassKg(p.Z, p.A);

      // Update continuous compression factor χ = ρ_effective / ρ_rest
      const oldChi = p.chi || 1.0;
      p.chi = Math.max(1.0, mTot / Math.max(1e-36, mRest));
      const phase = getVoxelPhase(el, tempK, p.chi);

      // 1. Force Summation: F_gravity + F_pressure_gradient + F_magnetic + F_lorentz + F_vorticity + F_drag
      let ax = bhAx, ay = bhAy;
      const dt = Math.max(1e-15, CONFIG.dtSim);

      if (CONFIG.enableGravity) {
        ax += sampleCoarseBilinear(UPCS.gxGrid, p.x, p.y);
        ay += sampleCoarseBilinear(UPCS.gyGrid, p.x, p.y);
      }
      if (CONFIG.earthDownwardG) {
        // Exact downward 9.81 m/s^2 converted to cells/tick^2
        ay += Math.min(25, (9.81 * dt * dt) / Math.max(1e-6, L));
      }

      // Pressure Gradient Force (-∇P / ρ) with reflecting zero-flux wall boundaries
      const cx = Math.max(0, Math.min(cw - 1, (p.x / bs) | 0));
      const cy = Math.max(0, Math.min(ch - 1, (p.y / bs) | 0));
      const cIdx = cy * cw + cx;
      const cxL = cx > 0 ? cx - 1 : 0;
      const cxR = cx < cw - 1 ? cx + 1 : cw - 1;
      const cyU = cy > 0 ? cy - 1 : 0;
      const cyD = cy < ch - 1 ? cy + 1 : ch - 1;
      const dPx = (UPCS.pressGrid[cy * cw + cxR] - UPCS.pressGrid[cy * cw + cxL]) / Math.max(1, cxR - cxL);
      const dPy = (UPCS.pressGrid[cyD * cw + cx] - UPCS.pressGrid[cyU * cw + cx]) / Math.max(1, cyD - cyU);
      const rho = Math.max(1e-12, mTot / Math.max(1e-36, Vcell));
      const rawPAx = -(dPx / (rho * bs * Math.max(1e-10, L))) * (dt * dt);
      const rawPAy = -(dPy / (rho * bs * Math.max(1e-10, L))) * (dt * dt);
      const maxPAccel = Math.min(18, 2.2 * Math.sqrt(Math.max(0.2, tempK / 300)) + Math.max(0, p.chi - 1) * 4.0);
      ax += maxPAccel * (rawPAx / (Math.abs(rawPAx) + maxPAccel * 8 + 1e-12));
      ay += maxPAccel * (rawPAy / (Math.abs(rawPAy) + maxPAccel * 8 + 1e-12));

      // Magnetism: Dipole Force F_mag = ∇(μ · B), Alignment Torque, Curie Demagnetization, Lorentz Force
      if (CONFIG.enableMagnetism && el) {
        const Bx = UPCS.bxGrid[cIdx], By = UPCS.byGrid[cIdx];
        if (el.curie_temp > 0) {
          if (tempK >= el.curie_temp) {
            // Exceeded Curie temperature -> thermal randomization destroys ferromagnetism
            p.mx *= 0.85; p.my *= 0.85;
          } else {
            // Alignment torque & dipole gradient attraction/repulsion
            const bMag = Math.hypot(Bx, By);
            if (bMag > 0.01) {
              const mMag = Math.hypot(p.mx, p.my) || 0.25;
              p.mx = p.mx * 0.92 + (Bx / bMag) * mMag * 0.08;
              p.my = p.my * 0.92 + (By / bMag) * mMag * 0.08;
              const dB = ((UPCS.bxGrid[cy * cw + cxR] - UPCS.bxGrid[cy * cw + cxL]) * p.mx +
                          (UPCS.byGrid[cy * cw + cxR] - UPCS.byGrid[cy * cw + cxL]) * p.my) / Math.max(1, cxR - cxL);
              const dBy = ((UPCS.bxGrid[cyD * cw + cx] - UPCS.bxGrid[cyU * cw + cx]) * p.mx +
                           (UPCS.byGrid[cyD * cw + cx] - UPCS.byGrid[cyU * cw + cx]) * p.my) / Math.max(1, cyD - cyU);
              ax += Math.max(-12, Math.min(12, dB * 1.4));
              ay += Math.max(-12, Math.min(12, dBy * 1.4));
            }
          }
        }
        // Lorentz Force F = q (v × B_z) for charged particles & ionized plasma
        const effQ = p.charge !== 0 ? p.charge : (phase === 3 ? 1.0 : 0);
        if (effQ !== 0) {
          const Bz = (Bx - By) * 0.35 + (UPCS.curlGrid[cIdx] * 0.2);
          ax += effQ * (p.vy * Bz) * 0.45;
          ay -= effQ * (p.vx * Bz) * 0.45;
        }
      }

      // Fluid Vorticity Confinement (interior tiles only so walls don't pull gas into borders)
      if (CONFIG.enableVorticity && cx > 0 && cx < cw - 1 && cy > 0 && cy < ch - 1) {
        const wC = UPCS.curlGrid[cIdx];
        const dwx = Math.abs(UPCS.curlGrid[cIdx + 1]) - Math.abs(UPCS.curlGrid[cIdx - 1]);
        const dwy = Math.abs(UPCS.curlGrid[cIdx + cw]) - Math.abs(UPCS.curlGrid[cIdx - cw]);
        const nLen = Math.hypot(dwx, dwy) + 1e-5;
        ax += (dwy / nLen) * wC * CONFIG.vorticityStrength;
        ay -= (dwx / nLen) * wC * CONFIG.vorticityStrength;
      }

      // Integrate velocity & apply mild drag
      const damp = 1 - CONFIG.dragCoeff * subDt;
      p.vx = (p.vx + ax * subDt) * damp;
      p.vy = (p.vy + ay * subDt) * damp;

      // CFL Velocity Clamp (displacement <= cflMaxDisp cells per substep)
      const maxV = CONFIG.cflMaxDisp / Math.max(1e-4, subDt);
      const vMag = Math.hypot(p.vx, p.vy);
      if (vMag > maxV) {
        const sc = maxV / vMag;
        p.vx *= sc;
        p.vy *= sc;
      }
      if (!Number.isFinite(p.vx)) p.vx = 0;
      if (!Number.isFinite(p.vy)) p.vy = 0;

      // 2. Advance sub-pixel position (ox, oy) within [-0.5, +0.5]
      p.ox += p.vx * subDt;
      p.oy += p.vy * subDt;

      let stepX = 0, stepY = 0;
      if (p.ox >= 0.5) stepX = 1; else if (p.ox <= -0.5) stepX = -1;
      if (p.oy >= 0.5) stepY = 1; else if (p.oy <= -0.5) stepY = -1;

      if (stepX !== 0 || stepY !== 0) {
        const nx = p.x + stepX, ny = p.y + stepY;
        const wallRest = phase >= 2 ? Math.max(0.85, CONFIG.restitution) : CONFIG.restitution;
        if (nx < 0 || nx > width || ny < 0 || ny > height) {
          // Boundary reflection (elastic for gases so they rebound cleanly off borders)
          if (nx < 0 || nx > width) { p.vx = -p.vx * wallRest; p.ox = Math.max(-0.49, Math.min(0.49, p.ox)); }
          if (ny < 0 || ny > height) { p.vy = -p.vy * wallRest; p.oy = Math.max(-0.49, Math.min(0.49, p.oy)); }
        } else if (typeof isEmpty === "function" && isEmpty(nx, ny)) {
          // Clean sub-pixel traversal into empty cell
          movePixel(p, nx, ny);
          p.ox -= stepX;
          p.oy -= stepY;
        } else {
          const target = pixelMap[nx] && pixelMap[nx][ny];
          if (target && target.isBlackHole && !target.del) {
            absorbVoxelIntoBlackHole(target, p);
          } else if (target && target.isUPCS && !target.del) {
            resolveVoxelCollisionOrPack(p, target, stepX, stepY);
          } else {
            p.vx = -p.vx * wallRest;
            p.vy = -p.vy * wallRest;
            p.ox = Math.max(-0.49, Math.min(0.49, p.ox));
            p.oy = Math.max(-0.49, Math.min(0.49, p.oy));
          }
        }
      }

      // 3. Multi-Voxel Thermal/Momentum Equilibration & Decompression Pop-Out
      if (CONFIG.enableMultiVoxelStack && p.stored_voxels && p.stored_voxels.length > 0) {
        equilibrateAndDecompress(p, Vcell);
      }

      // 4. Adiabatic Heating/Cooling from Δχ
      if (CONFIG.enableCompression && Math.abs(p.chi - oldChi) > 0.01) {
        const dChi = p.chi - oldChi;
        const th = getThermoProps(p.Z, p.A, tempK, p.chi);
        const dT_ad = Math.max(-800, Math.min(3500, dChi * 160 * (tempK / 300) / Math.max(0.2, th.C_v / 1000)));
        p.temp = Math.max(-270, (p.temp ?? 20) + dT_ad);
      }
    }
  }

  function resolveVoxelCollisionOrPack(p1, p2, nx, ny) {
    const m1 = Math.max(1e-30, getTotalMassKg(p1));
    const m2 = Math.max(1e-30, getTotalMassKg(p2));
    const rvx = p1.vx - p2.vx, rvy = p1.vy - p2.vy;
    const nLen = Math.hypot(nx, ny) || 1;
    const ux = nx / nLen, uy = ny / nLen;
    const velAlongNormal = rvx * ux + rvy * uy;

    // Check Compression Packing using physical ram + gravitational pressure vs material bulk modulus
    const impactSpeed = Math.max(0, velAlongNormal);
    const localG = Math.hypot(
      sampleCoarseBilinear(UPCS.gxGrid, p2.x, p2.y),
      sampleCoarseBilinear(UPCS.gyGrid, p2.x, p2.y)
    );
    const L = CONFIG.voxelSizeMeters;
    const dt = Math.max(1e-15, CONFIG.dtSim);
    const Vcell = getCellVolume();
    const rho2 = m2 / Math.max(1e-36, Vcell);
    const vImpactMS = impactSpeed * (L / dt);
    const gMS2 = localG * (L / (dt * dt));
    const P_ram = 0.5 * rho2 * vImpactMS * vImpactMS;
    const P_grav = rho2 * gMS2 * L * Math.max(1, p2.chi || 1);
    const el2 = ELEMENTS[p2.Z];
    const tempK2 = Math.max(0.5, (p2.temp ?? 20) + 273.15);
    const ph2 = getVoxelPhase(el2, tempK2, p2.chi || 1);
    const K_eff = ph2 >= 2 ? 2e5 : Math.max(1e7, el2 ? el2.K_bulk : 1e9);
    const physPackRatio = (P_ram + P_grav) / K_eff;
    const canPack = CONFIG.enableCompression && CONFIG.enableMultiVoxelStack &&
      p2.stored_voxels.length < CONFIG.maxStoredPerCell &&
      physPackRatio >= 0.25 * CONFIG.packingChiThreshold;

    if (canPack) {
      // Pack primary p1 (and any of its stored_voxels) into p2.stored_voxels
      p2.stored_voxels.push({
        Z: p1.Z, A: p1.A, is_metastable: !!p1.is_metastable,
        mass: getRestMassKg(p1.Z, p1.A), temp: p1.temp ?? 20,
        vx: p1.vx, vy: p1.vy, charge: p1.charge, mx: p1.mx, my: p1.my
      });
      if (p1.stored_voxels && p1.stored_voxels.length > 0) {
        for (let k = 0; k < p1.stored_voxels.length && p2.stored_voxels.length < CONFIG.maxStoredPerCell; k++) {
          p2.stored_voxels.push(p1.stored_voxels[k]);
        }
      }
      // Conserve center-of-mass momentum & convert inelastic impact energy to adiabatic heat
      const mSum = m1 + m2;
      p2.vx = (m1 * p1.vx + m2 * p2.vx) / mSum;
      p2.vy = (m1 * p1.vy + m2 * p2.vy) / mSum;
      const dT = Math.min(6000, impactSpeed * impactSpeed * 95 + 45);
      p2.temp = (p2.temp ?? 20) + dT;
      p2.chi = getTotalMassKg(p2) / Math.max(1e-36, getRestMassKg(p2.Z, p2.A));

      if (typeof deletePixel === "function") deletePixel(p1.x, p1.y);
      return;
    }

    // Standard Momentum-Conserving Elastic/Inelastic Collision
    if (velAlongNormal > 0) {
      const e = ph2 >= 2 ? Math.max(0.85, CONFIG.restitution) : CONFIG.restitution;
      const j = -(1 + e) * velAlongNormal / (1 / m1 + 1 / m2);
      const impX = j * ux, impY = j * uy;
      p1.vx += impX / m1;
      p1.vy += impY / m1;
      p2.vx -= impX / m2;
      p2.vy -= impY / m2;

      // Convert lost inelastic KE into local ΔT
      const dT = Math.min(800, (1 - e * e) * velAlongNormal * velAlongNormal * 14);
      p1.temp = (p1.temp ?? 20) + dT;
      p2.temp = (p2.temp ?? 20) + dT;
    }
    p1.ox = Math.max(-0.48, Math.min(0.48, p1.ox));
    p1.oy = Math.max(-0.48, Math.min(0.48, p1.oy));
  }

  function equilibrateAndDecompress(p, Vcell) {
    const arr = p.stored_voxels;
    let avgT = p.temp ?? 20;
    for (let i = 0; i < arr.length; i++) avgT += arr[i].temp;
    avgT /= (arr.length + 1);
    p.temp = avgT;
    for (let i = 0; i < arr.length; i++) {
      arr[i].temp = avgT;
      arr[i].vx = p.vx;
      arr[i].vy = p.vy;
    }

    // Compare outward thermal/degeneracy pressure vs confining gravity
    const gMag = Math.hypot(
      sampleCoarseBilinear(UPCS.gxGrid, p.x, p.y),
      sampleCoarseBilinear(UPCS.gyGrid, p.x, p.y)
    );
    const tempK = Math.max(1, avgT + 273.15);
    const P_out = (tempK / 2500) + (p.chi - 1) * 0.55;
    const P_in = gMag * 0.9 + (p.remnant === "ns" ? 12 : p.remnant === "wd" ? 4 : 0.6);

    if (P_out > P_in && Math.random() < 0.28) {
      // Find lowest-pressure adjacent empty cell
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      let bestDir = null;
      for (let d = 0; d < dirs.length; d++) {
        const nx = p.x + dirs[d][0], ny = p.y + dirs[d][1];
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && typeof isEmpty === "function" && isEmpty(nx, ny)) {
          bestDir = dirs[d];
          break;
        }
      }
      if (bestDir) {
        const sv = arr.pop();
        const nx = p.x + bestDir[0], ny = p.y + bestDir[1];
        const key = ELEMENT_KEY_BY_Z[sv.Z];
        if (key && typeof createPixel === "function") {
          createPixel(key, nx, ny);
          const q = pixelMap[nx] && pixelMap[nx][ny];
          if (q) {
            initVoxel(q, sv.Z);
            q.A = sv.A;
            q.is_metastable = sv.is_metastable;
            const ejectV = Math.min(6.0, 0.8 + (P_out - P_in) * 0.6);
            q.vx = p.vx + bestDir[0] * ejectV;
            q.vy = p.vy + bestDir[1] * ejectV;
            // Adiabatic cooling on expansion
            q.temp = Math.max(-270, avgT * 0.88 - 25);
            p.temp = Math.max(-270, avgT * 0.94 - 12);
            q.charge = sv.charge; q.mx = sv.mx; q.my = sv.my;
          }
        }
        p.chi = Math.max(1.0, getTotalMassKg(p) / Math.max(1e-36, getRestMassKg(p.Z, p.A)));
      }
    }
  }

  // ==========================================================================
  // 11. CONSERVATION LEDGER & MAIN TICK ORCHESTRATOR
  // ==========================================================================
  function updateConservationLedger(activePixels) {
    let M = 0, Eth = 0, Ekin = 0, Egrav = 0, Px = 0, Py = 0, Lz = 0, stored = 0;
    const cx0 = width * 0.5, cy0 = height * 0.5;
    const L = CONFIG.voxelSizeMeters;
    const vToMS = L / Math.max(1e-15, CONFIG.dtSim);

    for (let i = 0; i < activePixels.length; i++) {
      const p = activePixels[i];
      if (!p || p.del) continue;
      const m = getTotalMassKg(p);
      M += m;
      stored += p.stored_voxels ? p.stored_voxels.length : 0;
      if (!p.isBlackHole) {
        const tempK = Math.max(0.5, (p.temp ?? 20) + 273.15);
        const el = ELEMENTS[p.Z];
        Eth += m * (el ? el.C_v : 500) * tempK;
      }
      const vxms = (p.vx || 0) * vToMS, vyms = (p.vy || 0) * vToMS;
      Ekin += 0.5 * m * (vxms * vxms + vyms * vyms);
      Px += m * vxms;
      Py += m * vyms;
      Lz += m * ((p.x - cx0) * vyms - (p.y - cy0) * vxms) * L;
      const phi = sampleCoarseBilinear(UPCS.phiGrid, p.x, p.y);
      Egrav += 0.5 * m * phi;
    }

    const Ldg = UPCS.ledger;
    Ldg.M_total = M;
    Ldg.E_thermal = Eth;
    Ldg.E_kinetic = Ekin;
    Ldg.E_grav = Egrav;
    Ldg.P_x = Px;
    Ldg.P_y = Py;
    Ldg.L_z = Lz;
    Ldg.voxelCount = activePixels.length;
    Ldg.storedCount = stored;
  }

  let tickCounter = 0;
  function upcsTick() {
    if (typeof currentPixels === "undefined" || typeof pixelMap === "undefined") return;
    const t0 = performance.now();
    tickCounter++;

    // Gather active UPCS voxels and live Black Hole voxels
    const active = [];
    UPCS.blackHoles.length = 0;
    for (let i = 0; i < currentPixels.length; i++) {
      const p = currentPixels[i];
      if (!p || p.del) continue;
      if (p.element === "upcs_black_hole") {
        if (!p.isUPCS || !p.isBlackHole) initBlackHoleVoxel(p);
        UPCS.blackHoles.push(p);
        active.push(p);
        continue;
      }
      if (!p.isUPCS) {
        const z = Z_BY_ELEMENT_KEY[p.element];
        if (z) initVoxel(p, z);
      }
      if (p.isUPCS) active.push(p);
    }

    ensureCoarseGrids();
    rebuildUidMap(active);
    solveCoarseFields(active);

    // CFL Sub-stepping (4 to 8 substeps per frame)
    const steps = Math.max(1, Math.min(8, CONFIG.substeps | 0));
    const subDt = 0.22 / steps;
    for (let s = 0; s < steps; s++) {
      stepChemicalBonds(active, subDt);
      stepKinematicsSubstep(active, subDt);
    }

    stepNeutronsAndPhotons();
    stepNuclearAndAstrophysics(active);

    if ((tickCounter & 3) === 0) {
      updateConservationLedger(active);
      refreshLedgerUI();
      refreshInspectorUI();
    }
    UPCS.ledger.lastTickMs = performance.now() - t0;
  }

  if (typeof runEveryTick === "function") {
    runEveryTick(upcsTick);
  } else {
    setInterval(upcsTick, 33);
  }

  // ==========================================================================
  // 12. 4-PASS MULTI-LAYER HiDPI RENDERING PIPELINE
  // Pass 1: Deep-space Background, Gravity Potential Contours & Magnetic Field Lines
  // Pass 2: Voxel Matter with Sub-Pixel Interpolation, Compression Brightness & ACES Blackbody
  // Pass 3: Crisp Anti-Aliased Vector Bond Lines (Single/Double/Triple/Ionic/Strain)
  // Pass 4: Post-Processing Additive HDR Glow (Plasma, Stars, Neutrons/Photons) + Pure-Black BH Horizons
  // Layered cleanly beneath Sandboxels' transparent #game canvas so Sandboxels' native
  // selection box, brush cursor, grid, and tool overlays always render unobstructed on top.
  // ==========================================================================
  let overlayCanvas = null;
  let octx = null;
  let overlayParent = null;
  let hasRenderPostPixelHook = false;

  if (typeof renderPostPixel === "function") {
    hasRenderPostPixelHook = true;
    renderPostPixel(function (pctx) {
      if (CONFIG.fullCustomRenderer && pctx && pctx.canvas) {
        pctx.clearRect(0, 0, pctx.canvas.width, pctx.canvas.height);
      }
    });
  }

  function clearSandboxelsPixelsLayer() {
    if (typeof canvasLayers !== "undefined" && canvasLayers && canvasLayers.pixels) {
      const pctx = canvasLayers.pixels.getContext("2d");
      if (pctx) pctx.clearRect(0, 0, canvasLayers.pixels.width, canvasLayers.pixels.height);
    }
  }

  function acesToneMap(v) {
    const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return Math.max(0, Math.min(1, (v * (a * v + b)) / (v * (c * v + d) + e)));
  }

  function getSandboxelsGridDims(game) {
    const cols = (typeof pixelSize === "number" && pixelSize > 0 && game && game.width > 0)
      ? (game.width / pixelSize)
      : (typeof width === "number" ? width + 1 : 100);
    const rows = (typeof pixelSize === "number" && pixelSize > 0 && game && game.height > 0)
      ? (game.height / pixelSize)
      : (typeof height === "number" ? height + 1 : 100);
    return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
  }

  function ensureCanvasLayerStyles() {
    if (document.getElementById("upcs-canvas-layer-style") || !document.head) return;
    const st = document.createElement("style");
    st.id = "upcs-canvas-layer-style";
    st.textContent = `
      #game.upcs-transparent-game {
        position: relative !important;
        z-index: 2 !important;
        background-color: transparent !important;
        background-image: none !important;
      }
    `;
    document.head.appendChild(st);
  }

  function ensureOverlayCanvas() {
    const game = document.getElementById("game");
    if (!game) return null;
    ensureCanvasLayerStyles();

    if (!overlayCanvas) {
      overlayCanvas = document.createElement("canvas");
      overlayCanvas.id = "upcs-overlay";
      overlayCanvas.style.pointerEvents = "none";

      // Prefer mounting inside #gameDiv (positioned parent) so scrolling & stacking stay exact
      const parent = game.parentElement;
      const parentPos = (parent && parent !== document.body && typeof window.getComputedStyle === "function")
        ? window.getComputedStyle(parent).position
        : "static";
      if (parent && parent !== document.body && parentPos !== "static") {
        overlayParent = parent;
        overlayCanvas.style.position = "absolute";
        parent.insertBefore(overlayCanvas, game);
      } else {
        overlayParent = null;
        overlayCanvas.style.position = "fixed";
        document.body.appendChild(overlayCanvas);
      }
      octx = overlayCanvas.getContext("2d");

      // Track mouse hover & Shift/I pinning on the game canvas
      game.addEventListener("mousemove", (ev) => {
        const rect = game.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const dims = getSandboxelsGridDims(game);
        UPCS.hoverX = Math.floor(((ev.clientX - rect.left) / rect.width) * dims.cols);
        UPCS.hoverY = Math.floor(((ev.clientY - rect.top) / rect.height) * dims.rows);
      });
      window.addEventListener("keydown", (ev) => {
        if (ev.key === "i" || ev.key === "I") {
          if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT")) return;
          pinHoveredVoxel();
        }
      });
    }

    // Layer #upcs-overlay BEHIND transparent #game when fullCustomRenderer + renderPostPixel is active
    // so Sandboxels' native selection box, cursor, grid & tools always draw unobstructed on top!
    const behindGame = CONFIG.fullCustomRenderer && hasRenderPostPixelHook;
    if (behindGame) {
      if (game.classList && !game.classList.contains("upcs-transparent-game")) {
        game.classList.add("upcs-transparent-game");
        clearSandboxelsPixelsLayer();
      }
      overlayCanvas.style.zIndex = "1";
    } else {
      if (game.classList && game.classList.contains("upcs-transparent-game")) {
        game.classList.remove("upcs-transparent-game");
      }
      overlayCanvas.style.zIndex = "3";
    }

    const rect = game.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.max(1, Math.round(rect.width * dpr));
    const targetH = Math.max(1, Math.round(rect.height * dpr));
    if (overlayCanvas.width !== targetW || overlayCanvas.height !== targetH) {
      overlayCanvas.width = targetW;
      overlayCanvas.height = targetH;
    }
    if (overlayParent) {
      const pRect = overlayParent.getBoundingClientRect();
      overlayCanvas.style.left = (rect.left - pRect.left - (overlayParent.clientLeft || 0)) + "px";
      overlayCanvas.style.top = (rect.top - pRect.top - (overlayParent.clientTop || 0)) + "px";
    } else {
      overlayCanvas.style.left = rect.left + "px";
      overlayCanvas.style.top = rect.top + "px";
    }
    overlayCanvas.style.width = rect.width + "px";
    overlayCanvas.style.height = rect.height + "px";
    const dims = getSandboxelsGridDims(game);
    return { game, rect, dpr, behindGame, cellW: rect.width / dims.cols, cellH: rect.height / dims.rows };
  }

  // Fallback overlay compositor used only if Sandboxels lacks renderPostPixel
  function renderSandboxelsSelectionAndGuiFallback(geom) {
    const { game, rect, cellW, cellH } = geom;

    if (typeof elements !== "undefined" && game.width > 0 && game.height > 0) {
      octx.save();
      octx.globalCompositeOperation = "source-over";
      octx.globalAlpha = 1;
      octx.imageSmoothingEnabled = false;
      octx.scale(rect.width / game.width, rect.height / game.height);
      try {
        if (typeof getPixel === "function" && typeof mousePos !== "undefined" && mousePos) {
          const hoverPixel = getPixel(Math.round(mousePos.x), Math.round(mousePos.y));
          if (hoverPixel && elements[hoverPixel.element] && typeof elements[hoverPixel.element].hoverRender === "function") {
            elements[hoverPixel.element].hoverRender(octx);
          }
        }
        if (typeof currentElement !== "undefined" && elements[currentElement] && typeof elements[currentElement].renderTool === "function") {
          elements[currentElement].renderTool(octx);
        }
      } catch (_) {}
      octx.restore();
    }

    let drewGuiLayer = false;
    const pixelsLayer = (typeof canvasLayers !== "undefined" && canvasLayers) ? canvasLayers.pixels : null;
    const guiLayer = (typeof canvasLayers !== "undefined" && canvasLayers) ? canvasLayers.gui : null;

    octx.save();
    octx.globalCompositeOperation = "source-over";
    octx.globalAlpha = 1;
    octx.imageSmoothingEnabled = false;
    if (typeof canvasLayersPost !== "undefined" && Array.isArray(canvasLayersPost)) {
      for (let i = 0; i < canvasLayersPost.length; i++) {
        const layerCanvas = canvasLayersPost[i];
        if (!layerCanvas || layerCanvas === pixelsLayer) continue;
        if (layerCanvas.width > 0 && layerCanvas.height > 0) {
          octx.drawImage(layerCanvas, 0, 0, rect.width, rect.height);
          if (layerCanvas === guiLayer) drewGuiLayer = true;
        }
      }
    }
    if (!drewGuiLayer && guiLayer && guiLayer.width > 0 && guiLayer.height > 0) {
      octx.drawImage(guiLayer, 0, 0, rect.width, rect.height);
      drewGuiLayer = true;
    }
    octx.restore();

    if (!drewGuiLayer && typeof mousePos !== "undefined" && mousePos && typeof mouseSize === "number") {
      const mouseOffset = mouseSize / 2;
      const mouseMin = Math.trunc(mouseOffset);
      let mouseMax = mouseMin;
      if (mouseOffset % 1 === 0) mouseMax--;
      const topLeftX = mousePos.x - mouseMin;
      const topLeftY = mousePos.y - mouseMin;
      const boxW = (mousePos.x + mouseMax) - topLeftX + 1;
      const boxH = (mousePos.y + mouseMax) - topLeftY + 1;
      const mColor = (typeof mouseColor === "string" && mouseColor)
        || (typeof settings !== "undefined" && settings && settings.mouseColor)
        || "white";
      const mAlpha = (typeof mouseAlpha === "number") ? mouseAlpha : 0.5;

      octx.save();
      octx.globalCompositeOperation = "source-over";
      octx.globalAlpha = mAlpha;
      octx.lineWidth = 2;
      octx.strokeStyle = mColor;
      octx.strokeRect(topLeftX * cellW, topLeftY * cellH, boxW * cellW, boxH * cellH);
      octx.restore();
    }
  }

  function render4Pass() {
    requestAnimationFrame(render4Pass);
    if (typeof currentPixels === "undefined" || typeof width !== "number") return;
    const geom = ensureOverlayCanvas();
    if (!geom || !octx) return;

    const { rect, dpr, behindGame, cellW, cellH } = geom;
    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, rect.width, rect.height);

    // --- PASS 1: Background & Field Layer ---
    if (CONFIG.fullCustomRenderer) {
      const grad = octx.createRadialGradient(
        rect.width * 0.5, rect.height * 0.5, 20,
        rect.width * 0.5, rect.height * 0.5, Math.max(rect.width, rect.height) * 0.75
      );
      grad.addColorStop(0, "#0C111D");
      grad.addColorStop(1, CONFIG.bgColor);
      octx.fillStyle = grad;
      octx.fillRect(0, 0, rect.width, rect.height);
    }

    if (CONFIG.showGravityContours && UPCS.phiGrid) {
      const bs = UPCS.blockSize;
      octx.strokeStyle = "rgba(56, 189, 248, 0.22)";
      octx.lineWidth = 1;
      for (let y = 1; y < UPCS.ch - 1; y++) {
        for (let x = 1; x < UPCS.cw - 1; x++) {
          const val = Math.abs(UPCS.phiGrid[y * UPCS.cw + x]);
          if (val > 1e-6) {
            const band = Math.floor(Math.log10(val + 1e-6) * 4);
            const rightBand = Math.floor(Math.log10(Math.abs(UPCS.phiGrid[y * UPCS.cw + x + 1]) + 1e-6) * 4);
            if (band !== rightBand) {
              octx.strokeRect(x * bs * cellW, y * bs * cellH, bs * cellW, bs * cellH);
            }
          }
        }
      }
    }

    if (CONFIG.showMagneticLines && UPCS.bxGrid) {
      const bs = UPCS.blockSize;
      octx.strokeStyle = "rgba(167, 139, 250, 0.45)";
      octx.lineWidth = 1;
      octx.beginPath();
      for (let y = 0; y < UPCS.ch; y += 2) {
        for (let x = 0; x < UPCS.cw; x += 2) {
          const idx = y * UPCS.cw + x;
          const bx = UPCS.bxGrid[idx], by = UPCS.byGrid[idx];
          const mag = Math.hypot(bx, by);
          if (mag > 0.05) {
            const sx = (x + 0.5) * bs * cellW;
            const sy = (y + 0.5) * bs * cellH;
            const len = Math.min(bs * cellW * 1.4, 4 + mag * 5);
            octx.moveTo(sx, sy);
            octx.lineTo(sx + (bx / mag) * len, sy + (by / mag) * len);
          }
        }
      }
      octx.stroke();
    }

    // --- PASS 2: Voxel Matter Layer (Sub-pixel + Compression Brightness + ACES Blackbody) ---
    const bbRgb = [0, 0, 0];
    const glowQueue = [];

    if (CONFIG.fullCustomRenderer) {
      for (let i = 0; i < currentPixels.length; i++) {
        const p = currentPixels[i];
        if (!p || p.del || p.isBlackHole || p.element === "upcs_black_hole") continue;
        const sx = (p.x + (p.ox || 0)) * cellW;
        const sy = (p.y + (p.oy || 0)) * cellH;

        if (!p.isUPCS) {
          octx.fillStyle = p.color || "#888";
          octx.fillRect(sx, sy, cellW + 0.5, cellH + 0.5);
          continue;
        }

        const el = ELEMENTS[p.Z];
        const base = el ? el.rgb : [180, 180, 180];
        const chi = Math.max(1.0, p.chi || 1.0);
        const tempK = Math.max(1, (p.temp ?? 20) + 273.15);

        // Logarithmic Compression Brightness Multiplier
        const bMult = Math.max(1.0, Math.min(CONFIG.maxBrightness, 1.0 + CONFIG.compressionBrightK * Math.log(chi)));
        // Tightening chroma slightly toward luminous white-cyan/gold core under compression
        const coreMix = Math.min(0.65, (bMult - 1.0) * 0.38);
        let r = (base[0] / 255) * bMult * (1 - coreMix) + 1.15 * coreMix;
        let g = (base[1] / 255) * bMult * (1 - coreMix) + 1.25 * coreMix;
        let b = (base[2] / 255) * bMult * (1 - coreMix) + 1.35 * coreMix;

        // Compact remnant signatures
        if (p.remnant === "ns") { r = 1.6; g = 2.1; b = 2.8; }
        else if (p.remnant === "wd") { r = 1.7; g = 1.85; b = 2.2; }
        else if (p.remnant === "bd") { r = 0.08; g = 0.09; b = 0.12; }

        // Blackbody Thermal Incandescence
        const bbWeight = queryBlackbodyLUT(tempK, bbRgb);
        if (bbWeight > 0) {
          const hdrGain = 1.0 + Math.min(3.5, Math.log10(Math.max(1, tempK / 1200)));
          r = r * (1 - bbWeight * 0.85) + (bbRgb[0] / 255) * bbWeight * hdrGain;
          g = g * (1 - bbWeight * 0.85) + (bbRgb[1] / 255) * bbWeight * hdrGain;
          b = b * (1 - bbWeight * 0.85) + (bbRgb[2] / 255) * bbWeight * hdrGain;
        }

        // ACES Filmic Tone Mapping
        const fr = (acesToneMap(r) * 255) | 0;
        const fg = (acesToneMap(g) * 255) | 0;
        const fb = (acesToneMap(b) * 255) | 0;
        octx.fillStyle = `rgb(${fr},${fg},${fb})`;
        octx.fillRect(sx, sy, cellW + 0.55, cellH + 0.55);

        if (CONFIG.enableHDRBloom && (tempK > 2400 || chi > 3.5 || p.remnant === "ns")) {
          if (glowQueue.length < 320) {
            glowQueue.push({ x: sx + cellW * 0.5, y: sy + cellH * 0.5, r: fr, g: fg, b: fb, rad: Math.min(26, cellW * (2.2 + Math.log10(Math.max(10, tempK / 500)))) });
          }
        }
      }
    }

    // --- PASS 3: Sleek Non-Voxel Vector Bond Overlay Layer ---
    if (CONFIG.showVectorBonds && UPCS.bonds.length > 0) {
      octx.lineCap = "round";
      for (let i = 0; i < UPCS.bonds.length; i++) {
        const b = UPCS.bonds[i];
        const pA = UPCS.uidToPixel.get(b.aUid);
        const pB = UPCS.uidToPixel.get(b.bUid);
        if (!pA || !pB || pA.isBlackHole || pB.isBlackHole) continue;
        const elA = ELEMENTS[pA.Z], elB = ELEMENTS[pB.Z];
        if (!elA || !elB) continue;

        const x1 = (pA.x + (pA.ox || 0) + 0.5) * cellW;
        const y1 = (pA.y + (pA.oy || 0) + 0.5) * cellH;
        const x2 = (pB.x + (pB.ox || 0) + 0.5) * cellW;
        const y2 = (pB.y + (pB.oy || 0) + 0.5) * cellH;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;

        // Color shifts smoothly toward warm amber/white when high-strain
        if (b.strain > 0.65) {
          octx.strokeStyle = `rgba(251, 191, 36, ${Math.min(0.95, 0.5 + b.strain * 0.45)})`;
        } else {
          const rgbA = elA.rgb, rgbB = elB.rgb;
          const mr = ((rgbA[0] + rgbB[0]) >> 1), mg = ((rgbA[1] + rgbB[1]) >> 1), mb = ((rgbA[2] + rgbB[2]) >> 1);
          octx.strokeStyle = `rgba(${mr}, ${mg}, ${mb}, 0.78)`;
        }

        octx.lineWidth = Math.max(1.0, Math.min(1.6, cellW * 0.16));
        octx.setLineDash(b.type === "ionic" ? [2.2, 2.2] : []);

        const gap = Math.max(1.8, cellW * 0.2);
        octx.beginPath();
        if (b.order === 1) {
          octx.moveTo(x1, y1); octx.lineTo(x2, y2);
        } else if (b.order === 2) {
          octx.moveTo(x1 + px * gap * 0.5, y1 + py * gap * 0.5); octx.lineTo(x2 + px * gap * 0.5, y2 + py * gap * 0.5);
          octx.moveTo(x1 - px * gap * 0.5, y1 - py * gap * 0.5); octx.lineTo(x2 - px * gap * 0.5, y2 - py * gap * 0.5);
        } else {
          octx.moveTo(x1, y1); octx.lineTo(x2, y2);
          octx.moveTo(x1 + px * gap, y1 + py * gap); octx.lineTo(x2 + px * gap, y2 + py * gap);
          octx.moveTo(x1 - px * gap, y1 - py * gap); octx.lineTo(x2 - px * gap, y2 - py * gap);
        }
        octx.stroke();
      }
      octx.setLineDash([]);
    }

    // --- PASS 4: Post-Processing & Additive HDR Glow Layer ---
    octx.globalCompositeOperation = "lighter";
    if (CONFIG.enableHDRBloom && glowQueue.length > 0) {
      const alpha = 0.14 * CONFIG.bloomIntensity;
      for (let i = 0; i < glowQueue.length; i++) {
        const g = glowQueue[i];
        const rg = octx.createRadialGradient(g.x, g.y, 0.5, g.x, g.y, g.rad);
        rg.addColorStop(0, `rgba(${g.r},${g.g},${g.b},${alpha})`);
        rg.addColorStop(1, "rgba(0,0,0,0)");
        octx.fillStyle = rg;
        octx.beginPath();
        octx.arc(g.x, g.y, g.rad, 0, Math.PI * 2);
        octx.fill();
      }
    }

    // Render Sub-grid Neutrons, Photons & Bond-Snap Sparks
    if (CONFIG.showNeutronsAndPhotons) {
      for (let i = 0; i < UPCS.neutrons.length; i++) {
        const n = UPCS.neutrons[i];
        const nx = (n.x + 0.5) * cellW, ny = (n.y + 0.5) * cellH;
        const isFast = n.energy_eV >= 1.0;
        octx.strokeStyle = isFast ? "rgba(56,189,248,0.9)" : "rgba(74,222,128,0.85)";
        octx.lineWidth = isFast ? 1.8 : 1.4;
        octx.beginPath();
        octx.moveTo(nx, ny);
        octx.lineTo(nx - n.vx * cellW * 0.9, ny - n.vy * cellH * 0.9);
        octx.stroke();
      }
      for (let i = 0; i < UPCS.photons.length; i++) {
        const ph = UPCS.photons[i];
        const px = (ph.x + 0.5) * cellW, py = (ph.y + 0.5) * cellH;
        octx.strokeStyle = `rgba(${ph.r},${ph.g},${ph.b},${Math.min(0.9, ph.life * 0.6)})`;
        octx.lineWidth = 1.5;
        octx.beginPath();
        octx.moveTo(px, py);
        octx.lineTo(px - ph.vx * cellW * 0.6, py - ph.vy * cellH * 0.6);
        octx.stroke();
      }
      for (let i = 0; i < UPCS.sparks.length; i++) {
        const sp = UPCS.sparks[i];
        octx.fillStyle = sp.color;
        octx.globalAlpha = Math.max(0, sp.life);
        octx.fillRect((sp.x + 0.5) * cellW - 1, (sp.y + 0.5) * cellH - 1, 2.5, 2.5);
      }
      octx.globalAlpha = 1;
    }

    // Render Black Hole Voxel Event Horizons on top of light/bloom (pure pitch-black, no misleading light)
    octx.globalCompositeOperation = "source-over";
    octx.globalAlpha = 1;
    for (let i = 0; i < currentPixels.length; i++) {
      const bh = currentPixels[i];
      if (!bh || bh.del || (!bh.isBlackHole && bh.element !== "upcs_black_hole")) continue;
      const bx = (bh.x + (bh.ox || 0) + 0.5) * cellW;
      const by = (bh.y + (bh.oy || 0) + 0.5) * cellH;
      const rsPx = Math.max(cellW * 0.65, (bh.Rs_cells || 1.25) * cellW);
      octx.fillStyle = "#000000";
      octx.beginPath();
      octx.arc(bx, by, rsPx, 0, Math.PI * 2);
      octx.fill();
    }

    // Highlight Pinned Inspector Voxel
    const pinned = getInspectedPixel();
    if (pinned && UPCS.pinnedUid) {
      octx.strokeStyle = "#38BDF8";
      octx.lineWidth = 1.5;
      octx.strokeRect(pinned.x * cellW - 1, pinned.y * cellH - 1, cellW + 2, cellH + 2);
    }

    // Fallback: composite Sandboxels GUI manually only when renderPostPixel hook is unavailable
    if (CONFIG.fullCustomRenderer && !behindGame) {
      renderSandboxelsSelectionAndGuiFallback(geom);
    }

    octx.restore();
  }
  requestAnimationFrame(render4Pass);

  // ==========================================================================
  // 13. SLEEK CONFIGURATION MENU, INSPECTOR/FLAG EDITOR & LEDGER UI
  // ==========================================================================
  const STYLE_CSS = `
    #upcs-dock { position:fixed; top:10px; right:10px; z-index:9999; display:flex; gap:6px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .upcs-btn { background:rgba(10,15,26,0.92); color:#E2E8F0; border:1px solid rgba(56,189,248,0.38); border-radius:6px; padding:6px 10px; font-size:12px; cursor:pointer; backdrop-filter:blur(8px); transition:all 0.15s; }
    .upcs-btn:hover, .upcs-btn.active { background:rgba(14,165,233,0.22); border-color:#38BDF8; color:#FFF; }
    .upcs-panel { position:fixed; top:48px; right:10px; width:360px; max-height:82vh; overflow-y:auto; z-index:9998; background:rgba(7,9,14,0.94); color:#E2E8F0; border:1px solid rgba(56,189,248,0.32); border-radius:10px; padding:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; box-shadow:0 12px 32px rgba(0,0,0,0.65); backdrop-filter:blur(10px); display:none; }
    .upcs-panel.open { display:block; }
    .upcs-h { font-size:12.5px; font-weight:700; color:#38BDF8; margin:0 0 8px 0; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(148,163,184,0.2); padding-bottom:5px; }
    .upcs-tabs { display:flex; gap:4px; margin-bottom:10px; }
    .upcs-tab { flex:1; text-align:center; padding:5px 4px; background:rgba(30,41,59,0.6); border:1px solid rgba(148,163,184,0.2); border-radius:5px; cursor:pointer; font-size:11px; color:#94A3B8; }
    .upcs-tab.active { background:rgba(56,189,248,0.22); border-color:#38BDF8; color:#F8FAFC; font-weight:700; }
    .upcs-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; margin-bottom:8px; }
    .upcs-chip { padding:5px 4px; background:rgba(15,23,42,0.85); border:1px solid rgba(148,163,184,0.25); border-radius:5px; color:#CBD5E1; font-size:10.5px; cursor:pointer; text-align:center; }
    .upcs-chip:hover { border-color:#38BDF8; color:#FFF; }
    .upcs-chip.active { background:rgba(56,189,248,0.25); border-color:#38BDF8; color:#FFF; font-weight:700; }
    .upcs-row { display:flex; justify-content:space-between; align-items:center; margin:6px 0; gap:8px; }
    .upcs-row input[type=number], .upcs-row select { background:#0F172A; color:#F8FAFC; border:1px solid rgba(148,163,184,0.35); border-radius:4px; padding:3px 6px; font-family:inherit; font-size:11px; }
    .upcs-row input[type=range] { width:130px; accent-color:#38BDF8; }
    .upcs-kv { display:grid; grid-template-columns:1fr auto; gap:3px 8px; background:rgba(15,23,42,0.65); border:1px solid rgba(148,163,184,0.18); border-radius:6px; padding:7px 9px; margin:6px 0; }
    .upcs-badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:700; }
    .upcs-badge.cache { background:rgba(34,197,94,0.22); color:#4ADE80; border:1px solid rgba(34,197,94,0.5); }
    .upcs-badge.solved { background:rgba(250,204,21,0.2); color:#FDE047; border:1px solid rgba(250,204,21,0.45); }
    .upcs-sec { display:none; }
    .upcs-sec.active { display:block; }
  `;

  function fmtSci(v, digits = 2) {
    if (!Number.isFinite(v)) return "∞";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e-2 && a < 1e4) return v.toFixed(digits);
    return v.toExponential(digits);
  }

  let uiRefs = {};
  function buildUI() {
    if (document.getElementById("upcs-dock")) return;
    const style = document.createElement("style");
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);

    // Floating Dock
    const dock = document.createElement("div");
    dock.id = "upcs-dock";
    dock.innerHTML = `
      <button class="upcs-btn" data-panel="config">Config & Scale</button>
      <button class="upcs-btn" data-panel="inspector">Inspector [I]</button>
      <button class="upcs-btn" data-panel="ledger">Ledger</button>
      <button class="upcs-btn" data-panel="presets">Scenarios</button>
    `;
    document.body.appendChild(dock);

    // 1. CONFIGURATION & VOXEL SCALE PANEL
    const cfgPanel = document.createElement("div");
    cfgPanel.id = "upcs-panel-config";
    cfgPanel.className = "upcs-panel";
    cfgPanel.innerHTML = `
      <div class="upcs-h"><span>UPCS Configuration</span><span id="upcs-scale-pill" style="color:#FDE047;font-size:11px">1 cm × 1 cm</span></div>
      <div class="upcs-tabs">
        <div class="upcs-tab active" data-tab="scale">Scale</div>
        <div class="upcs-tab" data-tab="physics">Physics</div>
        <div class="upcs-tab" data-tab="nuclear">Nuc/Chem</div>
        <div class="upcs-tab" data-tab="visuals">Visuals</div>
      </div>

      <div class="upcs-sec active" id="upcs-tab-scale">
        <div style="color:#94A3B8;margin-bottom:5px">Voxel Side Length Presets (Atom → Stellar):</div>
        <div class="upcs-grid" id="upcs-preset-grid"></div>
        <div class="upcs-row">
          <span>Custom Size:</span>
          <div style="display:flex;gap:4px">
            <input type="number" id="upcs-custom-val" value="1" step="any" min="0.001" style="width:72px">
            <select id="upcs-custom-unit">
              <option value="A">Å (Atom)</option><option value="nm">nm</option><option value="um">µm</option>
              <option value="mm">mm</option><option value="cm" selected>cm</option><option value="m">m</option>
              <option value="km">km</option><option value="Mm">Mm</option>
            </select>
            <button class="upcs-chip" id="upcs-apply-custom">Set</button>
          </div>
        </div>
        <div class="upcs-kv" id="upcs-scale-readout"></div>
        <div class="upcs-row">
          <label><input type="checkbox" id="upcs-auto-dt" checked> Auto Time-Step (Δt)</label>
          <input type="number" id="upcs-manual-dt" value="0.01" step="any" style="width:92px">
        </div>
        <div class="upcs-row">
          <label><input type="checkbox" id="upcs-scaled-astro" checked> Sandbox-Scaled Stellar Remnants</label>
        </div>
      </div>

      <div class="upcs-sec" id="upcs-tab-physics">
        <div class="upcs-row"><label><input type="checkbox" id="upcs-kin" checked> Continuous Sub-Pixel Kinematics</label></div>
        <div class="upcs-row"><span>CFL Sub-Steps (<b id="upcs-sub-v">4</b>)</span><input type="range" id="upcs-sub" min="1" max="8" value="4"></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-grav" checked> Poisson Self-Gravity</label></div>
        <div class="upcs-row"><span>Gravity Mult (<b id="upcs-gmult-v">1.0</b>x)</span><input type="range" id="upcs-gmult" min="0" max="50" step="0.5" value="1"></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-earthg"> Lab Downward Gravity (1g)</label></div>
        <div class="upcs-row"><span>Coarse Grid Block</span><select id="upcs-bs"><option value="4" selected>4×4 Cells</option><option value="8">8×8 Cells</option></select></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-comp" checked> Compression (χ) & Stacking</label></div>
        <div class="upcs-row"><span>Elasticity (<b id="upcs-rest-v">0.35</b>)</span><input type="range" id="upcs-rest" min="0" max="1" step="0.05" value="0.35"></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-vort" checked> Fluid Vorticity Confinement</label></div>
      </div>

      <div class="upcs-sec" id="upcs-tab-nuclear">
        <div class="upcs-row"><label><input type="checkbox" id="upcs-bond" checked> Vector-Graph Chemical Bonding</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-cat" checked> Transition-Metal Catalysts</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-fus" checked> Nuclear Fusion & Stellar Evolution</label></div>
        <div class="upcs-row"><span>Fusion Rate (<b id="upcs-frate-v">1.0</b>x)</span><input type="range" id="upcs-frate" min="0.1" max="10" step="0.1" value="1"></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-fis" checked> Fission & Sub-Grid Neutrons</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-dec" checked> Radioactive Isotope Decay</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-rad" checked> Opacity Radiative Transfer</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-mag" checked> Vector Magnetism & MHD Lorentz</label></div>
        <div class="upcs-row"><span>Ext B-Field X (<b id="upcs-bx-v">0</b>)</span><input type="range" id="upcs-bx" min="-5" max="5" step="0.2" value="0"></div>
        <hr style="border-color:rgba(148,163,184,0.2)">
        <div style="color:#38BDF8;font-weight:700;margin-bottom:4px">Brush Isotope Override (Clean Menu Mode)</div>
        <div class="upcs-row">
          <span>Paint Mass A (blank=default):</span>
          <input type="number" id="upcs-brush-a" placeholder="Auto" min="1" max="350" style="width:72px">
        </div>
        <div class="upcs-row">
          <label><input type="checkbox" id="upcs-brush-meta"> Metastable (m)</label>
          <label>Dipole: <input type="number" id="upcs-brush-dip" value="0" step="0.5" style="width:52px"></label>
        </div>
      </div>

      <div class="upcs-sec" id="upcs-tab-visuals">
        <div class="upcs-row"><label><input type="checkbox" id="upcs-4pass" checked> Full 4-Pass HiDPI Renderer (#07090E)</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-bonds-v" checked> Pass 3: Anti-Aliased Vector Bonds</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-bloom" checked> Pass 4: Additive HDR Bloom</label></div>
        <div class="upcs-row"><span>Bloom Intensity (<b id="upcs-blm-v">0.85</b>)</span><input type="range" id="upcs-blm" min="0" max="2" step="0.05" value="0.85"></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-gcont"> Pass 1: Gravity Potential Contours</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-mlines"> Pass 1: Magnetic Field Vectors</label></div>
        <div class="upcs-row"><label><input type="checkbox" id="upcs-nphot" checked> Neutron & Photon Trails</label></div>
      </div>
    `;
    document.body.appendChild(cfgPanel);

    // 2. INSPECTOR & ISOTOPE FLAG EDITOR PANEL
    const inspPanel = document.createElement("div");
    inspPanel.id = "upcs-panel-inspector";
    inspPanel.className = "upcs-panel";
    inspPanel.innerHTML = `
      <div class="upcs-h"><span>Voxel Inspector & Flag Editor</span><button class="upcs-chip" id="upcs-unpin">Unpin</button></div>
      <div style="color:#94A3B8;font-size:10.5px;margin-bottom:6px">Hover any voxel or press <b>I</b> to pin and edit isotope flags live.</div>
      <div id="upcs-insp-body">No UPCS voxel under cursor.</div>
    `;
    document.body.appendChild(inspPanel);

    // 3. GLOBAL CONSERVATION LEDGER PANEL
    const ldgPanel = document.createElement("div");
    ldgPanel.id = "upcs-panel-ledger";
    ldgPanel.className = "upcs-panel";
    ldgPanel.innerHTML = `
      <div class="upcs-h"><span>Global Conservation Ledger</span><span id="upcs-ms" style="color:#4ADE80">0.0 ms</span></div>
      <div class="upcs-kv" id="upcs-ledger-body"></div>
    `;
    document.body.appendChild(ldgPanel);

    // 4. QUICK SCENARIO SPAWNERS PANEL
    const prePanel = document.createElement("div");
    prePanel.id = "upcs-panel-presets";
    prePanel.className = "upcs-panel";
    prePanel.innerHTML = `
      <div class="upcs-h"><span>Quick Physics Scenarios</span></div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="upcs-btn" id="sc-atom">1. Atomic Chemistry Lab (Atom Scale: H₂O + C + O₂)</button>
        <button class="upcs-btn" id="sc-fission">2. U-235 Moderated Fission Core (1 cm Scale)</button>
        <button class="upcs-btn" id="sc-star">3. Main Sequence Star (10,000 km Scale)</button>
        <button class="upcs-btn" id="sc-supernova">4. Pre-Supernova Onion-Shell Star (10,000 km)</button>
        <button class="upcs-btn" id="sc-mhd">5. Magnetized Iron & Plasma MHD (10 cm Scale)</button>
      </div>
    `;
    document.body.appendChild(prePanel);

    // Populate Scale Preset Buttons
    const pGrid = document.getElementById("upcs-preset-grid");
    SCALE_PRESETS.forEach(pr => {
      const btn = document.createElement("button");
      btn.className = "upcs-chip" + (pr.id === CONFIG.scalePreset ? " active" : "");
      btn.dataset.scale = pr.id;
      btn.textContent = pr.label;
      btn.title = pr.desc;
      btn.onclick = () => applyScalePreset(pr.id);
      pGrid.appendChild(btn);
    });

    // Dock Panel Switching
    dock.querySelectorAll(".upcs-btn").forEach(btn => {
      btn.onclick = () => {
        const target = document.getElementById("upcs-panel-" + btn.dataset.panel);
        const wasOpen = target.classList.contains("open");
        document.querySelectorAll(".upcs-panel").forEach(p => p.classList.remove("open"));
        dock.querySelectorAll(".upcs-btn").forEach(b => b.classList.remove("active"));
        if (!wasOpen) { target.classList.add("open"); btn.classList.add("active"); }
      };
    });

    // Config Sub-Tabs
    cfgPanel.querySelectorAll(".upcs-tab").forEach(tab => {
      tab.onclick = () => {
        cfgPanel.querySelectorAll(".upcs-tab").forEach(t => t.classList.remove("active"));
        cfgPanel.querySelectorAll(".upcs-sec").forEach(s => s.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("upcs-tab-" + tab.dataset.tab).classList.add("active");
      };
    });

    // Bind Config Inputs
    const bindChk = (id, key) => {
      const el = document.getElementById(id);
      el.onchange = () => { CONFIG[key] = el.checked; };
    };
    const bindRng = (id, key, valId) => {
      const el = document.getElementById(id);
      el.oninput = () => { CONFIG[key] = parseFloat(el.value); if (valId) document.getElementById(valId).textContent = el.value; };
    };

    const applyCustomFromInputs = () => {
      const v = parseFloat(document.getElementById("upcs-custom-val").value);
      const u = document.getElementById("upcs-custom-unit").value;
      if (v > 0 && UNIT_TO_METERS[u]) {
        applyCustomVoxelSize(v * UNIT_TO_METERS[u]);
      }
    };
    document.getElementById("upcs-apply-custom").onclick = applyCustomFromInputs;
    document.getElementById("upcs-custom-val").onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); applyCustomFromInputs(); }
    };
    document.getElementById("upcs-custom-unit").onchange = applyCustomFromInputs;
    document.getElementById("upcs-auto-dt").onchange = (e) => {
      CONFIG.autoDt = e.target.checked;
      if (CONFIG.autoDt) {
        const preset = SCALE_PRESETS.find(s => s.id === CONFIG.scalePreset);
        CONFIG.dtSim = preset ? preset.autoDt : computeAutoDt(CONFIG.voxelSizeMeters);
      }
      syncConfigUI();
    };
    document.getElementById("upcs-manual-dt").onchange = (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) { CONFIG.autoDt = false; CONFIG.dtSim = v; document.getElementById("upcs-auto-dt").checked = false; syncConfigUI(); }
    };
    bindChk("upcs-scaled-astro", "sandboxScaledAstro");
    bindChk("upcs-kin", "enableKinematics");
    bindRng("upcs-sub", "substeps", "upcs-sub-v");
    bindChk("upcs-grav", "enableGravity");
    bindRng("upcs-gmult", "gravityMultiplier", "upcs-gmult-v");
    bindChk("upcs-earthg", "earthDownwardG");
    document.getElementById("upcs-bs").onchange = (e) => { CONFIG.coarseBlockSize = parseInt(e.target.value, 10); };
    bindChk("upcs-comp", "enableCompression");
    bindRng("upcs-rest", "restitution", "upcs-rest-v");
    bindChk("upcs-vort", "enableVorticity");
    bindChk("upcs-bond", "enableBonding");
    bindChk("upcs-cat", "enableCatalysts");
    bindChk("upcs-fus", "enableFusion");
    bindRng("upcs-frate", "fusionRateMult", "upcs-frate-v");
    bindChk("upcs-fis", "enableFission");
    bindChk("upcs-dec", "enableDecay");
    bindChk("upcs-rad", "enableRadiativeTransfer");
    bindChk("upcs-mag", "enableMagnetism");
    bindRng("upcs-bx", "externalBx", "upcs-bx-v");
    document.getElementById("upcs-brush-a").onchange = (e) => {
      const v = parseInt(e.target.value, 10);
      CONFIG.brushIsotopeA = Number.isFinite(v) && v > 0 ? v : null;
    };
    bindChk("upcs-brush-meta", "brushMetastable");
    document.getElementById("upcs-brush-dip").onchange = (e) => { CONFIG.brushDipole = parseFloat(e.target.value) || 0; };
    document.getElementById("upcs-4pass").onchange = (e) => {
      CONFIG.fullCustomRenderer = e.target.checked;
      if (CONFIG.fullCustomRenderer) clearSandboxelsPixelsLayer();
    };
    bindChk("upcs-bonds-v", "showVectorBonds");
    bindChk("upcs-bloom", "enableHDRBloom");
    bindRng("upcs-blm", "bloomIntensity", "upcs-blm-v");
    bindChk("upcs-gcont", "showGravityContours");
    bindChk("upcs-mlines", "showMagneticLines");
    bindChk("upcs-nphot", "showNeutronsAndPhotons");
    document.getElementById("upcs-unpin").onclick = () => { UPCS.pinnedUid = null; refreshInspectorUI(); };

    // Bind Quick Scenarios
    document.getElementById("sc-atom").onclick = spawnAtomScenario;
    document.getElementById("sc-fission").onclick = spawnFissionScenario;
    document.getElementById("sc-star").onclick = () => spawnStarScenario(false);
    document.getElementById("sc-supernova").onclick = () => spawnStarScenario(true);
    document.getElementById("sc-mhd").onclick = spawnMHDScenario;

    syncConfigUI();
  }

  function formatMetersBestUnit(meters) {
    const units = [["Mm", 1e6], ["km", 1e3], ["m", 1], ["cm", 1e-2], ["mm", 1e-3], ["um", 1e-6], ["nm", 1e-9], ["A", 1e-10]];
    for (let i = 0; i < units.length; i++) {
      if (meters >= units[i][1] * 0.999) {
        const val = meters / units[i][1];
        return { unit: units[i][0], val: Number(val.toPrecision(4)) };
      }
    }
    return { unit: "A", val: Number((meters / 1e-10).toPrecision(4)) };
  }

  function syncConfigUI() {
    const pill = document.getElementById("upcs-scale-pill");
    const ro = document.getElementById("upcs-scale-readout");
    if (!pill || !ro) return;
    const preset = SCALE_PRESETS.find(s => s.id === CONFIG.scalePreset);
    const best = formatMetersBestUnit(CONFIG.voxelSizeMeters);
    pill.textContent = preset ? preset.label : `${best.val} ${best.unit === "um" ? "µm" : best.unit === "A" ? "Å" : best.unit}`;
    document.querySelectorAll("#upcs-preset-grid .upcs-chip").forEach(c => {
      c.classList.toggle("active", c.dataset.scale === CONFIG.scalePreset);
    });
    const cVal = document.getElementById("upcs-custom-val");
    const cUnit = document.getElementById("upcs-custom-unit");
    if (cVal && cUnit && document.activeElement !== cVal) {
      cVal.value = best.val;
      cUnit.value = best.unit;
    }
    const mDt = document.getElementById("upcs-manual-dt");
    if (mDt) mDt.value = CONFIG.dtSim;

    ro.innerHTML = `
      <span>Mode:</span><b>${CONFIG.isAtomicMode ? "Single-Atom Direct" : "Continuum Voxel"}</b>
      <span>Side Length (L):</span><b>${fmtSci(CONFIG.voxelSizeMeters)} m</b>
      <span>Cell Volume (L³):</span><b>${fmtSci(getCellVolume())} m³</b>
      <span>H-1 Voxel Mass:</span><b>${fmtSci(getRestMassKg(1, 1))} kg</b>
      <span>Fe-56 Voxel Mass:</span><b>${fmtSci(getRestMassKg(26, 56))} kg</b>
      <span>Sim Δt / tick:</span><b>${fmtSci(CONFIG.dtSim)} s</b>
    `;
  }

  function pinHoveredVoxel() {
    if (UPCS.hoverX < 0 || UPCS.hoverY < 0 || UPCS.hoverX > width || UPCS.hoverY > height) return;
    const p = pixelMap[UPCS.hoverX] && pixelMap[UPCS.hoverX][UPCS.hoverY];
    if (p && p.isUPCS) {
      UPCS.pinnedUid = (UPCS.pinnedUid === p._uid) ? null : p._uid;
      document.getElementById("upcs-panel-inspector").classList.add("open");
      refreshInspectorUI();
    }
  }

  function getInspectedPixel() {
    if (UPCS.pinnedUid && UPCS.uidToPixel.has(UPCS.pinnedUid)) return UPCS.uidToPixel.get(UPCS.pinnedUid);
    if (UPCS.hoverX >= 0 && UPCS.hoverX <= width && UPCS.hoverY >= 0 && UPCS.hoverY <= height) {
      const p = pixelMap[UPCS.hoverX] && pixelMap[UPCS.hoverX][UPCS.hoverY];
      if (p && p.isUPCS) return p;
    }
    return null;
  }

  function refreshInspectorUI() {
    const panel = document.getElementById("upcs-panel-inspector");
    if (!panel || !panel.classList.contains("open")) return;
    const body = document.getElementById("upcs-insp-body");
    const p = getInspectedPixel();
    if (!p) { body.innerHTML = `<div style="color:#64748B">Hover a Periodic Table voxel or press <b>I</b> to pin.</div>`; return; }

    if (p.isBlackHole || p.element === "upcs_black_hole") {
      const mKg = getTotalMassKg(p);
      const vCells = Math.hypot(p.vx || 0, p.vy || 0);
      const vMS = vCells * CONFIG.voxelSizeMeters / Math.max(1e-15, CONFIG.dtSim);
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <b style="font-size:13px;color:#F8FAFC">Black Hole (Singularity Voxel)</b>
          <span class="upcs-badge cache">EVENT HORIZON</span>
        </div>
        <div class="upcs-kv">
          <span>Mass (kg):</span><b>${fmtSci(mKg)} kg</b>
          <span>Mass (Solar M☉):</span><b>${fmtSci(mKg / PHYS.M_sun)} M☉</b>
          <span>Horizon Radius (R_s):</span><b>${(p.Rs_cells || 1.25).toFixed(2)} cells</b>
          <span>Absorbed Voxels:</span><b>${p.absorbedCount || 0}</b>
          <span>Spin Parameter:</span><b>${(p.spin || 0).toFixed(2)}</b>
          <span>Velocity |v|:</span><b>${vCells.toFixed(2)} c/s (${fmtSci(vMS)} m/s)</b>
        </div>
        <div style="color:#94A3B8;font-size:10.5px">Right-click or use Erase on this voxel to delete the Black Hole.</div>
      `;
      return;
    }

    const el = ELEMENTS[p.Z];
    if (!el) return;
    const iso = getIsotopeParams(p.Z, p.A, p.is_metastable);
    const name = getIsotopeDisplayName(p.Z, p.A, p.is_metastable);
    const tempK = Math.max(0.5, (p.temp ?? 20) + 273.15);
    const phaseNames = ["Solid", "Liquid", "Gas", "Plasma"];
    const ph = phaseNames[getVoxelPhase(el, tempK, p.chi || 1)];
    const vCells = Math.hypot(p.vx || 0, p.vy || 0);
    const vMS = vCells * CONFIG.voxelSizeMeters / Math.max(1e-15, CONFIG.dtSim);
    const badgeCls = iso.source === "CACHE" ? "cache" : "solved";
    const isPinned = UPCS.pinnedUid === p._uid;

    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="font-size:13px;color:#F8FAFC">${name}</b>
        <span class="upcs-badge ${badgeCls}">${iso.source === "CACHE" ? "TIER-1 CACHE" : "TIER-2 SOLVED"}</span>
      </div>
      <div class="upcs-kv">
        <span>Atomic / Mass (Z / A):</span><b>Z=${p.Z} (${el.symbol}) | A=${p.A}${p.is_metastable ? "m" : ""}</b>
        <span>Stability / Half-Life:</span><b>${iso.stable ? "Stable" : `${iso.decayMode} (${fmtSci(iso.halfLifeSec)} s)`}</b>
        <span>Phase / Remnant:</span><b>${ph}${p.remnant ? " [" + p.remnant.toUpperCase() + "]" : ""}</b>
        <span>Temperature:</span><b>${fmtSci(tempK, 1)} K (${fmtSci(p.temp ?? 20, 1)} °C)</b>
        <span>Compression (χ):</span><b>${(p.chi || 1).toFixed(2)}×</b>
        <span>stored_voxels:</span><b>${p.stored_voxels ? p.stored_voxels.length : 0} packed</b>
        <span>Total Mass:</span><b>${fmtSci(getTotalMassKg(p))} kg</b>
        <span>Velocity |v|:</span><b>${vCells.toFixed(2)} c/s (${fmtSci(vMS)} m/s)</b>
        <span>Active Bonds:</span><b>${UPCS.bondCountByUid.get(p._uid) || 0} / ${el.valence_slots}</b>
      </div>
      ${isPinned ? `
        <div style="color:#38BDF8;font-weight:700;margin:6px 0 4px">Live Isotope Flag Editor (Pinned)</div>
        <div class="upcs-row">
          <span>Mass Number (A):</span>
          <div style="display:flex;gap:4px">
            <input type="number" id="ed-iso-a" value="${p.A}" min="${p.Z}" max="350" style="width:68px">
            <button class="upcs-chip" id="ed-iso-apply">Apply</button>
          </div>
        </div>
        <div class="upcs-row">
          <label><input type="checkbox" id="ed-iso-meta" ${p.is_metastable ? "checked" : ""}> Metastable Isomer (m)</label>
          <button class="upcs-chip" id="ed-spawn-n">Fire Thermal n⁰</button>
        </div>
      ` : `<div style="color:#94A3B8;font-size:10.5px">Press <b>I</b> while hovering to pin & edit flags.</div>`}
    `;

    if (isPinned) {
      document.getElementById("ed-iso-apply").onclick = () => {
        const newA = parseInt(document.getElementById("ed-iso-a").value, 10);
        const newMeta = document.getElementById("ed-iso-meta").checked;
        if (Number.isFinite(newA) && newA >= p.Z) {
          p.A = newA;
          p.is_metastable = newMeta;
          refreshInspectorUI();
        }
      };
      document.getElementById("ed-iso-meta").onchange = (e) => { p.is_metastable = e.target.checked; refreshInspectorUI(); };
      document.getElementById("ed-spawn-n").onclick = () => { spawnNeutron(p.x, p.y, 0.025); };
    }
  }

  function refreshLedgerUI() {
    const panel = document.getElementById("upcs-panel-ledger");
    if (!panel || !panel.classList.contains("open")) return;
    const L = UPCS.ledger;
    document.getElementById("upcs-ms").textContent = `${L.lastTickMs.toFixed(1)} ms`;
    const Etot = L.E_thermal + L.E_kinetic + L.E_chemical + L.E_nuclear + L.E_grav + L.E_radiated;
    document.getElementById("upcs-ledger-body").innerHTML = `
      <span>Active Voxels / Packed:</span><b>${L.voxelCount} / ${L.storedCount}</b>
      <span>Bonds / Neutrons / BHs:</span><b>${UPCS.bonds.length} / ${UPCS.neutrons.length} / ${UPCS.blackHoles.length}</b>
      <span>Total Mass (M):</span><b>${fmtSci(L.M_total)} kg</b>
      <span>E_thermal:</span><b>${fmtSci(L.E_thermal)} J</b>
      <span>E_kinetic:</span><b>${fmtSci(L.E_kinetic)} J</b>
      <span>E_chemical:</span><b>${fmtSci(L.E_chemical)} J</b>
      <span>E_nuclear (Δ):</span><b>${fmtSci(L.E_nuclear)} J</b>
      <span>E_grav:</span><b>${fmtSci(L.E_grav)} J</b>
      <span>E_radiated:</span><b>${fmtSci(L.E_radiated)} J</b>
      <span>Total Energy Ledger:</span><b style="color:#38BDF8">${fmtSci(Etot)} J</b>
      <span>Linear Momentum |P|:</span><b>${fmtSci(Math.hypot(L.P_x, L.P_y))} kg·m/s</b>
      <span>Angular Momentum L_z:</span><b>${fmtSci(L.L_z)} kg·m²/s</b>
      <span>Cache Entries (Bond/Iso):</span><b>${bondCache.size} / ${isoCache.size}</b>
    `;
  }

  // ==========================================================================
  // 14. QUICK SCENARIO SPAWNERS (Demonstrate Every Scale & Regime)
  // ==========================================================================
  function clearWorldSafe() {
    UPCS.bonds.length = 0;
    UPCS.neutrons.length = 0;
    UPCS.delayedNeutrons.length = 0;
    UPCS.photons.length = 0;
    UPCS.blackHoles.length = 0;
    if (typeof clearAll === "function") clearAll();
  }

  function placeVoxel(Z, A, x, y, opts = {}) {
    if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) return null;
    const key = ELEMENT_KEY_BY_Z[Z];
    if (!key || typeof createPixel !== "function") return null;
    if (pixelMap[x] && pixelMap[x][y] && typeof deletePixel === "function") deletePixel(x, y);
    createPixel(key, x, y);
    const p = pixelMap[x] && pixelMap[x][y];
    if (!p) return null;
    initVoxel(p, Z);
    p.A = A;
    if (opts.temp !== undefined) p.temp = opts.temp;
    if (opts.vx !== undefined) p.vx = opts.vx;
    if (opts.vy !== undefined) p.vy = opts.vy;
    if (opts.mx !== undefined) p.mx = opts.mx;
    if (opts.charge !== undefined) p.charge = opts.charge;
    return p;
  }

  function spawnAtomScenario() {
    clearWorldSafe();
    applyScalePreset("atom");
    CONFIG.enableGravity = false;
    CONFIG.enableBonding = true;
    const cx = (width * 0.5) | 0, cy = (height * 0.5) | 0;
    // Mix of Hydrogen, Oxygen, Carbon, and a Platinum catalyst surface
    for (let dx = -12; dx <= 12; dx += 2) {
      for (let dy = -8; dy <= 6; dy += 2) {
        const r = Math.random();
        const Z = r < 0.5 ? 1 : r < 0.8 ? 8 : 6;
        placeVoxel(Z, ELEMENTS[Z].default_mass_number, cx + dx, cy + dy, {
          temp: 420, vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5
        });
      }
    }
    for (let dx = -10; dx <= 10; dx++) placeVoxel(78, 195, cx + dx, cy + 10, { temp: 300 }); // Pt catalyst
  }

  function spawnFissionScenario() {
    clearWorldSafe();
    applyScalePreset("1cm");
    CONFIG.enableGravity = false;
    CONFIG.enableFission = true;
    const cx = (width * 0.5) | 0, cy = (height * 0.5) | 0;
    // Heavy Water (Deuterium + Oxygen) moderator bath + U-235 fuel rods + Boron-10 control rods
    for (let dx = -10; dx <= 10; dx++) {
      for (let dy = -8; dy <= 8; dy++) {
        if (Math.abs(dx) === 4 || Math.abs(dx) === 0) {
          placeVoxel(92, 235, cx + dx, cy + dy, { temp: 350 }); // Uranium-235 fuel rod
        } else if (Math.abs(dx) === 8) {
          placeVoxel(5, 10, cx + dx, cy + dy, { temp: 250 });   // Boron-10 control rod
        } else if ((dx + dy) % 2 === 0) {
          placeVoxel(1, 2, cx + dx, cy + dy, { temp: 200 });    // Deuterium moderator
        } else {
          placeVoxel(8, 16, cx + dx, cy + dy, { temp: 200 });
        }
      }
    }
    for (let k = 0; k < 6; k++) spawnNeutron(cx, cy, 0.025);
  }

  function spawnStarScenario(preSupernova) {
    clearWorldSafe();
    applyScalePreset("10000km");
    CONFIG.enableGravity = true;
    CONFIG.gravityMultiplier = 4.0;
    CONFIG.enableFusion = true;
    const cx = (width * 0.5) | 0, cy = (height * 0.5) | 0;
    const R = Math.min(14, Math.floor(Math.min(width, height) * 0.28));
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        const r = Math.hypot(dx, dy);
        if (r > R) continue;
        const frac = r / R;
        // Slight initial rotation for angular momentum conservation
        const vx = -dy * 0.08, vy = dx * 0.08;
        if (preSupernova) {
          if (frac < 0.22) placeVoxel(26, 56, cx + dx, cy + dy, { temp: 4.9e9, vx, vy });
          else if (frac < 0.38) placeVoxel(14, 28, cx + dx, cy + dy, { temp: 2.9e9, vx, vy });
          else if (frac < 0.55) placeVoxel(8, 16, cx + dx, cy + dy, { temp: 1.6e9, vx, vy });
          else if (frac < 0.72) placeVoxel(6, 12, cx + dx, cy + dy, { temp: 6e8, vx, vy });
          else if (frac < 0.86) placeVoxel(2, 4, cx + dx, cy + dy, { temp: 1.2e8, vx, vy });
          else placeVoxel(1, 1, cx + dx, cy + dy, { temp: 8e6, vx, vy });
        } else {
          // Main Sequence star: H-1 + trace C-12 for CNO cycle
          const isC = frac < 0.35 && Math.random() < 0.08;
          const Z = isC ? 6 : 1;
          placeVoxel(Z, isC ? 12 : 1, cx + dx, cy + dy, { temp: (1 - frac * 0.8) * 1.8e7, vx, vy });
        }
      }
    }
  }

  function spawnMHDScenario() {
    clearWorldSafe();
    applyScalePreset("10cm");
    CONFIG.enableGravity = false;
    CONFIG.enableMagnetism = true;
    CONFIG.showMagneticLines = true;
    const cx = (width * 0.5) | 0, cy = (height * 0.5) | 0;
    // Magnetized Iron bar in center
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        placeVoxel(26, 56, cx + dx, cy + dy, { temp: 25, mx: 4.5 });
      }
    }
    // Hot ionized Hydrogen plasma streams curving via Lorentz force
    for (let dx = -12; dx <= 12; dx += 2) {
      placeVoxel(1, 1, cx + dx, cy - 10, { temp: 18000, vx: 1.8, vy: 0.6, charge: 1 });
      placeVoxel(1, 1, cx + dx, cy + 10, { temp: 18000, vx: -1.8, vy: -0.6, charge: -1 });
    }
  }

  // Mount UI once DOM is ready
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", buildUI);
  } else {
    setTimeout(buildUI, 350);
  }
})();
