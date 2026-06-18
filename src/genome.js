// =============================================================================
// genome.js — GRASS genome layer (continuous morphospace)
//
// A genome is a flat object with one numeric gene per field in GRASS_SCHEMA.
// It is the single object passed to the render pipeline to produce all
// render-ready data for one grass specimen.
//
// CONTINUOUS MORPHOSPACE (No Man's Sky-style):
//   All genes are kind:'continuous' (float in [lo,hi]) except structuralSeed
//   which is kind:'seed' (uint32).
//
// RNG DRAW ORDER for randomGenome(env, seed):
//   Draws are consumed from mulberry32(seed) in a FIXED documented order.
//   This order is FROZEN — any change shifts subsequent draws for all seeds.
//   Structural genes (5):
//     Draw 01: tillerCount
//     Draw 02: clumpSpread
//     Draw 03: bladeSegments
//     Draw 04: seedHead
//     Draw 05: fanSpread
//   Proportions genes (8):
//     Draw 06: bladeLength
//     Draw 07: tipDroop
//     Draw 08: bladeWidth
//     Draw 09: bladeTaper
//     Draw 10: arch
//     Draw 11: curve
//     Draw 12: stiffness
//     Draw 13: verticality
//   Cosmetic genes (5 continuous + 1 seed):
//     Draw 14: pigment      (wide hue spread — full [0,1] range → full HSL hue wheel)
//     Draw 15: bladeRaggedness
//     Draw 16: colorVariation
//     Draw 17: jitter
//     Draw 18: midribStrength
//     Draw 19: structuralSeed  — (rng()*2**32)>>>0  (FINAL draw)
//
// NEUTRAL DEFAULTS — the sensible "mid lawn blade" plant:
//   tillerCount:     0.45  (≈6 blades: 1 + 0.45*11 ≈ 5.9)
//   clumpSpread:     0.30  (moderate spread)
//   bladeSegments:   0.40  (≈5 segments: 3 + round(0.40*5) = 5)
//   seedHead:        0.00  (no seed heads by default)
//   fanSpread:       0.50  (moderate fan spread)
//   bladeLength:     0.35  (mid lawn: 0.15 + 0.35*(2.2-0.15) ≈ 0.87 m)
//   tipDroop:        0.10  (slight tip droop)
//   bladeWidth:      0.45  (moderate ribbon width)
//   bladeTaper:      0.70  (moderately tapered — lawn-like)
//   arch:            0.25  (mild bow — not stiff, not drooping)
//   curve:           0.15  (slight lateral curve)
//   stiffness:       0.60  (fairly stiff)
//   verticality:     0.55  (slightly more erect than prostrate)
//   pigment:         0.30  (green-ish neutral — ~108° hue on HSL wheel)
//   bladeRaggedness: 0.10  (slightly ragged edge)
//   colorVariation:  0.20  (mild per-blade variety)
//   jitter:          0.40  (moderate positional noise)
//   midribStrength:  0.20  (subtle midrib crease)
//
// ENV→GENE BIAS TABLE (envOffset):
//   Neutral env: gravity=1, medium='air', light=0.6, wind=0.2, aridity=0.35, temperature=0.5
//   All offsets are 0 at the neutral env so only seedVariation applies.
//
//   wind (w, neutral=0.2):
//     windDelta = clamp((wind - 0.2) / 0.8, 0, 1)
//     verticality -= 0.20 * windDelta   (wind → low/prostrate)
//     stiffness   += 0.25 * windDelta   (wind → stiffer to resist bending)
//
//   aridity + temperature → narrow/short blades:
//     aridHeat = clamp(aridFrac*0.5 + tempFrac*0.5, -1, 1)
//     bladeLength -= 0.25 * aridHeat   (dry+hot → shorter blades)
//     bladeWidth  -= 0.20 * aridHeat   (dry+hot → narrower blades)
//
//   light (l, neutral=0.6):
//     lightDelta = clamp((0.6 - light) / 0.6, -1, 1)  (positive = dim)
//     bladeLength += 0.20 * lightDelta   (dim → reaching taller)
//
// SEED VARIATION (±spread, drawn in the fixed order above):
//   Most genes: ±0.12 of full range (small but visible variation)
//   pigment:    full [0,1] range (draw maps directly to [0,1])
//   jitter:     ±0.20 of range
//
// speciesColor → pigmentToColor (colorRamp.js, single source of truth):
//   Full HSL hue wheel — pigment 0→1 maps hue 0°→360° (S=0.55, L=0.42).
//
// resolve(genome, env) pipeline:
//   buildSkeleton → solveProportions → generateFoliage
//   NO roots. NO skin. Returns the frozen shape per §2 of GRASS_PLAN.md.
//
// Pure ESM — no three.js dependency.
// =============================================================================

import { mulberry32 }               from './rng.js';
import { buildSkeleton }            from './skeleton.js';
import { solveProportions }         from './proportions.js';
import { GRASS_SCHEMA, clampField } from './genomeSchema.js';
import { generateFoliage }          from './foliage.js';
import { pigmentToColor }           from './colorRamp.js';

// ---------------------------------------------------------------------------
// Neutral gene vector
// ---------------------------------------------------------------------------
// These are the sensible "mid lawn blade" defaults. envOffset and seedVariation
// are added on top of these values before clamping.
// ---------------------------------------------------------------------------

const NEUTRAL = Object.freeze({
  // Structural
  tillerCount:     0.45,
  clumpSpread:     0.30,
  bladeSegments:   0.40,
  seedHead:        0.00,
  fanSpread:       0.50,
  // Proportions
  bladeLength:     0.35,
  tipDroop:        0.10,
  bladeWidth:      0.45,
  bladeTaper:      0.70,
  arch:            0.25,
  curve:           0.15,
  stiffness:       0.60,
  verticality:     0.55,
  // Cosmetic (pigment handled separately via seed draw)
  pigment:         0.30,
  bladeRaggedness: 0.10,
  colorVariation:  0.20,
  jitter:          0.40,
  midribStrength:  0.20,
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clamp v to [lo, hi]. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Compute environment-driven gene offsets (envOffset).
 *
 * All offsets are 0 at the neutral environment:
 *   gravity=1, medium='air', light=0.6, wind=0.2, aridity=0.35, temperature=0.5
 *
 * Returns a partial object with only the genes that need offsetting.
 * Absent genes default to 0 in the caller.
 */
function computeEnvOffset(env) {
  const {
    wind        = 0.2,
    aridity     = 0.35,
    temperature = 0.5,
    light       = 0.6,
  } = env;

  const offset = {
    tillerCount:     0,
    clumpSpread:     0,
    bladeSegments:   0,
    seedHead:        0,
    fanSpread:       0,
    bladeLength:     0,
    tipDroop:        0,
    bladeWidth:      0,
    bladeTaper:      0,
    arch:            0,
    curve:           0,
    stiffness:       0,
    verticality:     0,
    pigment:         0,
    bladeRaggedness: 0,
    colorVariation:  0,
    jitter:          0,
    midribStrength:  0,
  };

  // --- wind → prostrate + stiff ---
  // windDelta: 0 at wind=0.2, range [0, 1]
  const windDelta = clamp((wind - 0.2) / 0.8, 0, 1);
  offset.verticality -= 0.20 * windDelta;
  offset.stiffness   += 0.25 * windDelta;

  // --- aridity + temperature → narrow/short blades ---
  // aridHeat: 0 at neutral (aridity=0.35, temp=0.5), range [-1, +1]
  const aridFrac = clamp((aridity - 0.35) / 0.65, -1, 1);
  const tempFrac = clamp((temperature - 0.5) / 0.5, -1, 1);
  const aridHeat = clamp(aridFrac * 0.5 + tempFrac * 0.5, -1, 1);
  offset.bladeLength -= 0.25 * aridHeat;
  offset.bladeWidth  -= 0.20 * aridHeat;

  // --- dim light → taller reaching blades ---
  // lightDelta: 0 at light=0.6, positive = dim
  const lightDelta = clamp((0.6 - light) / 0.6, -1, 1);
  offset.bladeLength += 0.20 * lightDelta;

  return offset;
}

/**
 * Draw seed variation for one gene.
 * spread is the half-width of the ±variation in [0,1] rng space.
 * Returns (draw - 0.5) * 2 * spread * rangeSpan.
 */
function seedVar(draw, spread, rangeSpan) {
  return (draw - 0.5) * 2 * spread * rangeSpan;
}

// ---------------------------------------------------------------------------
// randomGenome(env, seed) -> genome (flat object, all genes in GRASS_SCHEMA)
// ---------------------------------------------------------------------------

/**
 * Construct a random genome from a numeric seed and an environment envelope.
 *
 * Each gene is computed as:
 *   clampField(GRASS_SCHEMA, name, geneNeutral[name] + envOffset[name] + seedVariation(rng))
 *
 * The rng draws are consumed in the FIXED order documented at the top of this file.
 * Repeating with the same (env, seed) produces bit-identical output.
 *
 * Returns a plain (non-frozen) object with all GRASS_SCHEMA fields.
 */
export function randomGenome(env, seed) {
  const rng    = mulberry32(seed);
  const offset = computeEnvOffset(env);

  // Standard seed spread for most genes (±12% of range)
  const STD = 0.12;

  // Helper: build one continuous gene value
  function gene(name, spread) {
    const schema = GRASS_SCHEMA[name];
    const [lo, hi] = schema.range;
    const span  = hi - lo;
    const raw   = NEUTRAL[name] + offset[name] + seedVar(rng(), spread, span);
    return clampField(GRASS_SCHEMA, name, raw);
  }

  // --- Structural (draws 01–05) ---
  const tillerCount   = gene('tillerCount',   STD);   // draw 01
  const clumpSpread   = gene('clumpSpread',   STD);   // draw 02
  const bladeSegments = gene('bladeSegments', STD);   // draw 03
  const seedHead      = gene('seedHead',      STD);   // draw 04
  const fanSpread     = gene('fanSpread',     STD);   // draw 05

  // --- Proportions (draws 06–13) ---
  const bladeLength = gene('bladeLength', STD);       // draw 06
  const tipDroop    = gene('tipDroop',    STD);       // draw 07
  const bladeWidth  = gene('bladeWidth',  STD);       // draw 08
  const bladeTaper  = gene('bladeTaper',  STD);       // draw 09
  const arch        = gene('arch',        STD);       // draw 10
  const curve       = gene('curve',       STD);       // draw 11
  const stiffness   = gene('stiffness',   STD);       // draw 12
  const verticality = gene('verticality', STD);       // draw 13

  // --- Cosmetic (draws 14–18 continuous, 19 seed) ---
  // pigment: wide hue spread across the full [0,1] range (maps draw directly)
  const pigment         = clampField(GRASS_SCHEMA, 'pigment', rng());             // draw 14
  const bladeRaggedness = gene('bladeRaggedness', STD);                           // draw 15
  const colorVariation  = gene('colorVariation',  STD);                           // draw 16
  const jitter          = gene('jitter',          0.20);                          // draw 17
  const midribStrength  = gene('midribStrength',  STD);                           // draw 18

  // structuralSeed: always a fresh uint32 from the rng (draw 19 — FINAL draw)
  const structuralSeed = (rng() * 2 ** 32) >>> 0;                                // draw 19

  return {
    // Structural
    tillerCount,
    clumpSpread,
    bladeSegments,
    seedHead,
    fanSpread,
    // Proportions
    bladeLength,
    tipDroop,
    bladeWidth,
    bladeTaper,
    arch,
    curve,
    stiffness,
    verticality,
    // Cosmetic
    pigment,
    bladeRaggedness,
    colorVariation,
    jitter,
    midribStrength,
    structuralSeed,
  };
}

// ---------------------------------------------------------------------------
// resolve(genome, env) -> render data  [PURE]
// ---------------------------------------------------------------------------

/**
 * Pure render-data pipeline from a genome + environment envelope.
 *
 * Pipeline: buildSkeleton → solveProportions → generateFoliage
 * NO roots. NO skin.
 *
 * Determinism contract:
 *   - Structural jitter uses mulberry32(genome.structuralSeed), a fresh rng
 *     created here each call. No shared mutable state is read or written.
 *   - solveProportions mutates the graph in-place, but the graph is created
 *     fresh every call, so repeated calls on the same (genome, env) pair
 *     produce deep-equal output.
 *
 * Returns (per §2 of GRASS_PLAN.md):
 *   {
 *     graph,              // { nodes, bones, meta } — solved (proportions applied in-place)
 *     genome,             // the source genome
 *     boneCount,          // graph.bones.length (stats panel)
 *     lightDir,           // graph.meta.lightDir
 *     pigment, colorVariation,
 *     bladeWidth, bladeTaper, midribStrength, bladeRaggedness,
 *     stiffness, arch,
 *     foliage,            // SoA (seed-heads) — may be count:0 in v1
 *   }
 */
export function resolve(genome, env) {
  // Fresh rng seeded from genome — never touches external state.
  const rng = mulberry32(genome.structuralSeed);

  // Build skeleton: grass clump-of-tillers.
  // jitterAmp defaults to 1.0 — genome.jitter is already read internally by
  // buildSkeleton (jAmp = genome.jitter * jitterAmp). Passing genome.jitter
  // here would square the jitter amplitude.
  const graph = buildSkeleton(genome, rng);

  // Solve proportions in-place (deterministic given same inputs).
  solveProportions(graph, env, genome);

  // Foliage: seed-head instance set (may be count:0 when seedHead===0).
  const foliage = generateFoliage(graph, genome);

  return {
    graph,
    genome,
    boneCount:       graph.bones.length,
    lightDir:        graph.meta.lightDir,
    pigment:         genome.pigment,
    colorVariation:  genome.colorVariation,
    bladeWidth:      genome.bladeWidth,
    bladeTaper:      genome.bladeTaper,
    midribStrength:  genome.midribStrength,
    bladeRaggedness: genome.bladeRaggedness,
    stiffness:       genome.stiffness,
    arch:            genome.arch,
    foliage,
  };
}

// ---------------------------------------------------------------------------
// speciesColor(genome) -> CSS color string  [single source of truth]
// ---------------------------------------------------------------------------

/**
 * Map genome.pigment ∈ [0, 1] to a CSS rgb() color string.
 *
 * Delegates to pigmentToColor (colorRamp.js) — the single source of truth
 * for the pigment→color mapping. UI swatches share the same color at any
 * pigment value.
 *
 * Full hue sweep: pigment 0→1 sweeps hue 0°→360° (HSL, S=0.55, L=0.42).
 */
export function speciesColor(genome) {
  const [r, g, b] = pigmentToColor(genome.pigment);
  const ri = Math.round(r * 255);
  const gi = Math.round(g * 255);
  const bi = Math.round(b * 255);
  return `rgb(${ri},${gi},${bi})`;
}
