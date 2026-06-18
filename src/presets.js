// =============================================================================
// presets.js — hand-authored gene-vector "bookmarks" in the grass morphospace
//
// Each preset is a named starting point, NOT a discrete plant type.
// They are regions of the same continuous morphospace — the user can tweak any
// slider or hit Generate after loading one.
//
// Construction: { ...GRASS_DEFAULT, ...overrides, structuralSeed: <distinct uint32> }
// This guarantees every GRASS_SCHEMA gene is present (no missing field → no NaN).
// Distinct structuralSeed per preset gives each its own consistent "hero" look;
// the reroll button generates new individuals of the same form.
//
// Categories (Task 9 CATEGORY_ORDER): ["Lawn","Meadow","Ornamental","Cereal","Wetland"]
// =============================================================================

// ---------------------------------------------------------------------------
// GRASS_DEFAULT — a believable mid lawn blade clump.
//
// Key tuning goals:
//   LAWN:    tillerCount=0.45 → ~6 blades; moderate clump spread; erect.
//   BLADE:   bladeLength=0.35 → ~0.87 m (mid lawn); moderate width + taper.
//   UPRIGHT: verticality=0.55 → slightly erect; arch=0.25 → mild bow.
//   CLEAN:   seedHead=0 → no inflorescence; slight midrib + ragged edge.
//   COLOR:   pigment=0.29 → muted olive/lawn green (hue ≈104° HSL, less vivid).
//            colorVariation=0.28 → visible-but-subtle per-blade spread via aColorJitter.
// ---------------------------------------------------------------------------
export const GRASS_DEFAULT = {
  // Structural
  tillerCount:     0.65,  // ≈8 blades (1 + 0.65*11) — fuller clump
  clumpSpread:     0.55,  // wide footprint (r=0.275 m) so clumps interlock at minDist=0.35
  bladeSegments:   0.80,  // ≈7 segments (3 + round(0.80*5)) — smooth curve, not faceted
  seedHead:        0.00,  // no inflorescence
  fanSpread:       0.70,  // wide azimuthal splay so clump edges feather into neighbours
  // Proportions
  bladeLength:     0.35,  // ≈0.87 m mid lawn blade
  bladeWidth:      0.15,  // narrow ribbon → half-width ≈ 5.2 mm, aspect ratio ~80:1
  bladeTaper:      0.95,  // nearly needle tip — tip collapses to ≈0.26 mm (grass-like point)
  arch:            0.20,  // gentle bow; not stiff, not drooping
  curve:           0.15,  // slight lateral curve
  stiffness:       0.60,  // fairly stiff
  verticality:     0.55,  // slightly more erect than prostrate
  tipDroop:        0.10,  // slight tip droop
  // Cosmetic
  pigment:         0.29,  // hue ≈ 104° on HSL wheel → muted olive/lawn green (less vivid)
  bladeRaggedness: 0.10,  // slightly ragged edge
  colorVariation:  0.28,  // visible-but-subtle per-blade variety (maps to aColorJitter)
  jitter:          0.40,  // moderate positional noise
  midribStrength:  0.20,  // subtle midrib crease
  structuralSeed:  1337,  // default structural seed (uint32)
};

// ---------------------------------------------------------------------------
// CATEGORY_ORDER — categories for the preset modal (Task 9 hardcodes this list).
// Agreed value; do NOT change without coordinating with Task 9's main.js.
// ---------------------------------------------------------------------------
export const CATEGORY_ORDER = Object.freeze([
  'Lawn',
  'Meadow',
  'Ornamental',
  'Cereal',
  'Wetland',
]);

// ---------------------------------------------------------------------------
// PRESETS — ordered array of { id, label, category, experimental, genome }.
// Hand-authored starting points; tune values via the sliders after loading.
//
// category ∈ CATEGORY_ORDER
// experimental: false for all production-quality presets.
// ---------------------------------------------------------------------------
export const PRESETS = [

  // ── Lawn ──────────────────────────────────────────────────────────────────

  // Default lawn — the baseline mid-lawn grass clump.
  {
    id:           'lawn',
    label:        'Lawn',
    category:     'Lawn',
    experimental: false,
    genome: { ...GRASS_DEFAULT },
  },

  // Fine fescue — very short dense turf; narrow blade, high tiller count.
  {
    id:           'fine-fescue',
    label:        'Fine Fescue',
    category:     'Lawn',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.85,  // very dense clump (≈10 blades)
      clumpSpread:     0.20,  // tight footprint
      bladeLength:     0.12,  // very short → ≈ 0.15+0.12*2.05 ≈ 0.40 m
      bladeWidth:      0.10,  // very narrow ribbon → half-width ≈ 4.8 mm
      bladeTaper:      0.95,  // near needle-tip
      arch:            0.10,  // near-stiff upright
      stiffness:       0.80,  // stiff blades
      verticality:     0.60,  // erect habit
      tipDroop:        0.05,
      colorVariation:  0.10,  // uniform lawn green
      bladeRaggedness: 0.05,  // clean edge
      pigment:         0.32,  // lawn green
      structuralSeed:  0xA3F72C11 >>> 0,
    },
  },

  // Creeping bent — very low, prostrate spreading turf.
  {
    id:           'creeping-bent',
    label:        'Creeping Bent',
    category:     'Lawn',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.70,
      clumpSpread:     0.55,  // wider spread
      bladeLength:     0.08,  // very short blades
      bladeWidth:      0.12,  // narrow → half-width ≈ 5.0 mm
      bladeTaper:      0.90,
      arch:            0.50,  // moderate arch → prostrate bend
      stiffness:       0.35,  // flexible, lies flat
      verticality:     0.20,  // prostrate/creeping habit
      curve:           0.30,  // slight lateral curve
      tipDroop:        0.25,
      colorVariation:  0.15,
      pigment:         0.33,
      fanSpread:       0.70,  // wide azimuthal fan
      structuralSeed:  0x5BE91042 >>> 0,
    },
  },

  // ── Meadow ────────────────────────────────────────────────────────────────

  // Mixed meadow — taller, varied blades with natural jitter.
  {
    id:           'meadow',
    label:        'Meadow',
    category:     'Meadow',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.55,
      clumpSpread:     0.45,
      bladeLength:     0.55,  // taller blades ≈ 1.28 m
      bladeWidth:      0.30,  // moderate → half-width ≈ 6.4 mm
      bladeTaper:      0.85,
      arch:            0.35,
      stiffness:       0.50,
      verticality:     0.55,
      curve:           0.25,
      tipDroop:        0.20,
      colorVariation:  0.35,  // more per-blade variety
      bladeRaggedness: 0.20,
      jitter:          0.60,  // higher positional noise → natural look
      pigment:         0.31,
      structuralSeed:  0x72D4A531 >>> 0,
    },
  },

  // Brome — tall upright meadow grass; robust wide blades.
  {
    id:           'brome',
    label:        'Brome',
    category:     'Meadow',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.40,
      clumpSpread:     0.35,
      bladeLength:     0.65,  // tall ≈ 1.48 m
      bladeWidth:      0.65,  // broad blade → half-width ≈ 9.2 mm (bromus can be 15mm wide)
      bladeTaper:      0.80,
      arch:            0.30,
      stiffness:       0.65,
      verticality:     0.60,
      curve:           0.10,
      tipDroop:        0.15,
      colorVariation:  0.25,
      bladeRaggedness: 0.15,
      jitter:          0.50,
      midribStrength:  0.30,
      pigment:         0.29,
      structuralSeed:  0xC48E7B04 >>> 0,
    },
  },

  // Tussock — big dense clump; high arch, moderate height; classical clumping grass.
  {
    id:           'tussock',
    label:        'Tussock',
    category:     'Meadow',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.80,  // very dense clump
      clumpSpread:     0.60,  // wide base
      bladeLength:     0.50,  // moderate-to-tall
      bladeWidth:      0.45,  // mid-width → half-width ≈ 7.6 mm
      bladeTaper:      0.85,
      arch:            0.55,  // pronounced arch → cascading look
      stiffness:       0.40,
      verticality:     0.55,
      curve:           0.20,
      tipDroop:        0.35,  // visible tip droop
      colorVariation:  0.30,
      bladeRaggedness: 0.25,
      jitter:          0.70,  // lots of natural jitter
      midribStrength:  0.15,
      pigment:         0.28,
      structuralSeed:  0x3F5A9D72 >>> 0,
    },
  },

  // ── Ornamental ────────────────────────────────────────────────────────────

  // Fountain grass — high arch + strong tipDroop; graceful cascade silhouette.
  {
    id:           'fountain',
    label:        'Fountain Grass',
    category:     'Ornamental',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.65,
      clumpSpread:     0.50,
      bladeLength:     0.70,  // tall ≈ 1.58 m
      bladeWidth:      0.40,
      bladeTaper:      0.75,
      arch:            0.75,  // KEY: strong gravitational bow
      stiffness:       0.30,  // flexible → allows droop
      verticality:     0.50,
      curve:           0.30,
      tipDroop:        0.70,  // KEY: heavy tip cascade
      colorVariation:  0.25,
      bladeRaggedness: 0.10,
      jitter:          0.45,
      midribStrength:  0.25,
      pigment:         0.35,  // warm green
      fanSpread:       0.65,
      structuralSeed:  0x91EAB302 >>> 0,
    },
  },

  // Blue fescue — low ornamental mound; blue-grey hue, very uniform.
  {
    id:           'blue-fescue',
    label:        'Blue Fescue',
    category:     'Ornamental',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.75,
      clumpSpread:     0.30,
      bladeLength:     0.20,  // short ≈ 0.56 m
      bladeWidth:      0.22,  // narrow
      bladeTaper:      0.80,
      arch:            0.30,
      stiffness:       0.70,
      verticality:     0.55,
      curve:           0.10,
      tipDroop:        0.10,
      colorVariation:  0.08,  // uniform blue-grey
      bladeRaggedness: 0.05,
      jitter:          0.25,
      midribStrength:  0.10,
      pigment:         0.58,  // blue-grey hue (≈210°)
      fanSpread:       0.50,
      structuralSeed:  0x1D7C4E89 >>> 0,
    },
  },

  // Pampas grass — very tall, wide blades; imposing ornamental clump.
  {
    id:           'pampas',
    label:        'Pampas Grass',
    category:     'Ornamental',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.55,
      clumpSpread:     0.55,
      bladeLength:     0.88,  // very tall ≈ 1.96 m
      bladeWidth:      0.80,  // broad ribbon
      bladeTaper:      0.60,
      arch:            0.55,
      stiffness:       0.50,
      verticality:     0.60,
      curve:           0.20,
      tipDroop:        0.40,
      colorVariation:  0.20,
      bladeRaggedness: 0.35,  // pronounced ragged edge
      jitter:          0.55,
      midribStrength:  0.30,
      pigment:         0.27,
      seedHead:        0.70,  // prominent plume / seed head
      fanSpread:       0.60,
      structuralSeed:  0xF3A04C17 >>> 0,
    },
  },

  // ── Cereal ────────────────────────────────────────────────────────────────

  // Wheat-ish — tall stiff single or few blades; seed head prominent.
  {
    id:           'wheat',
    label:        'Wheat',
    category:     'Cereal',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.18,  // few tillers per clump
      clumpSpread:     0.15,  // tight base
      bladeLength:     0.75,  // tall ≈ 1.69 m
      bladeWidth:      0.40,  // moderate width → half-width ≈ 7.2 mm
      bladeTaper:      0.80,
      arch:            0.15,  // mostly upright
      stiffness:       0.80,  // stiff stem
      verticality:     0.65,
      curve:           0.05,  // near-straight
      tipDroop:        0.10,
      colorVariation:  0.12,
      bladeRaggedness: 0.08,
      jitter:          0.30,
      midribStrength:  0.25,
      pigment:         0.25,  // yellow-green wheat hue
      seedHead:        0.90,  // KEY: prominent seed head / ear
      fanSpread:       0.30,
      structuralSeed:  0x64B2F715 >>> 0,
    },
  },

  // Barley — drooping awned ear; slight arch; gold-green.
  {
    id:           'barley',
    label:        'Barley',
    category:     'Cereal',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.20,
      clumpSpread:     0.18,
      bladeLength:     0.68,
      bladeWidth:      0.38,  // moderate → half-width ≈ 7.0 mm
      bladeTaper:      0.80,
      arch:            0.30,  // slight arch — barley nods gently
      stiffness:       0.70,
      verticality:     0.60,
      curve:           0.08,
      tipDroop:        0.30,  // nodding grain head
      colorVariation:  0.10,
      bladeRaggedness: 0.08,
      jitter:          0.30,
      midribStrength:  0.22,
      pigment:         0.23,  // gold-green
      seedHead:        0.85,
      fanSpread:       0.30,
      structuralSeed:  0xA0D93E46 >>> 0,
    },
  },

  // ── Wetland ───────────────────────────────────────────────────────────────

  // Reed — very tall, stiff, sparse blades; low arch; wetland edge plant.
  {
    id:           'reed',
    label:        'Reed',
    category:     'Wetland',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.12,  // very few tillers (≈2 blades)
      clumpSpread:     0.20,
      bladeLength:     0.90,  // very tall ≈ 1.99 m
      bladeWidth:      0.70,  // moderately broad → half-width ≈ 9.6 mm (Phragmites ~15mm)
      bladeTaper:      0.70,  // less taper — ribbon stays broad toward tip
      arch:            0.10,  // near-upright
      stiffness:       0.85,  // very stiff
      verticality:     0.70,
      curve:           0.05,
      tipDroop:        0.08,
      colorVariation:  0.10,
      bladeRaggedness: 0.12,
      jitter:          0.35,
      midribStrength:  0.35,
      pigment:         0.32,
      fanSpread:       0.25,
      seedHead:        0.40,  // modest panicle
      structuralSeed:  0x2C5F1B08 >>> 0,
    },
  },

  // Sedge — clumping wetland sedge; arching blades, distinctive V cross-section (midrib).
  {
    id:           'sedge',
    label:        'Sedge',
    category:     'Wetland',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.60,
      clumpSpread:     0.40,
      bladeLength:     0.45,
      bladeWidth:      0.40,  // sedge blades are broader than lawn grass → half-width ≈ 7.2 mm
      bladeTaper:      0.80,
      arch:            0.45,  // arching habit
      stiffness:       0.55,
      verticality:     0.55,
      curve:           0.35,  // prominent lateral curve
      tipDroop:        0.25,
      colorVariation:  0.20,
      bladeRaggedness: 0.18,
      jitter:          0.50,
      midribStrength:  0.55,  // KEY: pronounced midrib/keel — sedge character
      pigment:         0.29,
      fanSpread:       0.55,
      seedHead:        0.15,
      structuralSeed:  0x7AE3D190 >>> 0,
    },
  },

  // Bulrush / cattail — very upright, few tall stems.
  {
    id:           'bulrush',
    label:        'Bulrush',
    category:     'Wetland',
    experimental: false,
    genome: {
      ...GRASS_DEFAULT,
      tillerCount:     0.08,  // very few tillers
      clumpSpread:     0.25,
      bladeLength:     0.95,  // near-maximum height ≈ 2.10 m
      bladeWidth:      0.55,  // broad → half-width ≈ 8.4 mm (Typha blades ~10-20mm)
      bladeTaper:      0.60,  // fairly parallel-sided — bulrush stays broad
      arch:            0.05,  // nearly vertical
      stiffness:       0.90,  // very stiff upright stems
      verticality:     0.75,
      curve:           0.03,
      tipDroop:        0.05,
      colorVariation:  0.08,
      bladeRaggedness: 0.10,
      jitter:          0.20,
      midribStrength:  0.20,
      pigment:         0.30,
      fanSpread:       0.20,
      seedHead:        0.60,  // prominent cylindrical flower head
      structuralSeed:  0xE82F6AD3 >>> 0,
    },
  },

];
