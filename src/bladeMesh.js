// =============================================================================
// bladeMesh.js — buildBladeGeometry(graph, opts) + createBladeMaterial()
//
// Converts a solved skeleton graph (buildSkeleton + solveProportions) into
// a flat tapered RIBBON mesh for grass blades.
//
// Pure ESM, no three.js import in buildBladeGeometry — node-testable.
// createBladeMaterial() and createBladeDepthMaterial() require a three.js
// MeshStandardMaterial / MeshDepthMaterial — caller provides the three instance.
//
// EXPORTED API:
//   buildBladeGeometry(graph, opts = {}) -> {
//     positions:    Float32Array(3*V),   // xyz per vertex
//     normals:      Float32Array(3*V),   // per-vertex normal (flat ribbon face)
//     uvs:          Float32Array(2*V),   // u ∈ [0,1] across width, v ∈ [0,1] along length
//     ao:           Float32Array(V),     // [0.35, 1] ambient occlusion (darker at base)
//     swayFactor:   Float32Array(V),     // 0 at blade base → 1 at tip, from node.swayBase
//     colorSeed:    Float32Array(V),     // per-blade [0,1] constant (for colorVariation tint)
//     indices:      Uint32Array(3*T),    // triangle indices
//     vertexCount:  V,
//     triangleCount: T,
//     bounds: { min:[x,y,z], max:[x,y,z] },
//     nodeToBlade:  Int32Array(nodes.length),  // node → blade index, -1 = not rendered
//   }
//
//   opts: {
//     bladeWidth      {number}  base half-width in world units (default: 0.015)
//     bladeTaper      {number}  [0,1] width falloff toward tip (0=parallel, 1=needle)
//     midribStrength  {number}  [0,1] midrib crease depth; 0=flat ribbon
//     bladeRaggedness {number}  [0,1] edge jitter amplitude (default: 0)
//     radialSegsFor   {function} ignored (reserved for future use)
//   }
//
//   createBladeMaterial(THREE, opts = {}) -> MeshStandardMaterial
//     opts: { windGlsl, pigment, colorVariation }
//     Injects windOffset(worldPos, aSwayFactor) via onBeforeCompile.
//     double-sided, vertex-color tint.
//
//   createBladeDepthMaterial(THREE, opts = {}) -> MeshDepthMaterial
//     Mirrors wind injection for shadow casting.
//
// RIBBON TOPOLOGY (without midrib, midribStrength=0):
//   Per non-tip chain node: 2 vertices — LEFT edge and RIGHT edge.
//   Tip node collapses to a single apex vertex.
//   A blade with N nodes has:
//     vertices:  2*(N-1) + 1
//     triangles: 2*(N-1) - 1
//   (Tip fan is one triangle; side:DoubleSide renders the back face.
//    The former coplanar reversed tip tri caused z-fighting + normal flip.)
//
// RIBBON TOPOLOGY (with midrib, midribStrength>0):
//   Per non-tip chain node: 3 vertices — LEFT, MIDRIB, RIGHT.
//   Tip apex: 1 vertex.
//   A blade with N nodes has:
//     vertices:  3*(N-1) + 1
//     triangles: 4*(N-2) + 2
//
// DETERMINISM: pure function of graph + opts. No Math.random, no Date, no global state.
// =============================================================================

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function v3len(v) {
  return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
}

function v3norm(v) {
  const len = v3len(v);
  if (len < 1e-12) return [1, 0, 0];
  return [v[0]/len, v[1]/len, v[2]/len];
}

function v3dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

function v3cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

function v3sub(a, b) {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}

function v3add(a, b) {
  return [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
}

function v3scale(v, s) {
  return [v[0]*s, v[1]*s, v[2]*s];
}

// Compute a stable perpendicular to a unit vector (rotation-minimizing frame seed).
function perpTo(dir) {
  if (Math.abs(v3dot(dir, [1, 0, 0])) < 0.9) {
    return v3norm(v3cross(dir, [1, 0, 0]));
  }
  return v3norm(v3cross(dir, [0, 0, 1]));
}

// Parallel-transport frame: rotate {u, v} to align with newTangent.
// Returns updated [u, v] (both unit, orthogonal to newTangent).
function transportFrame(prevTangent, newTangent, u, v) {
  const d = Math.max(-1, Math.min(1, v3dot(prevTangent, newTangent)));
  if (d > 1 - 1e-10) return [u, v];

  const axisRaw = v3cross(prevTangent, newTangent);
  const axisLen = v3len(axisRaw);
  if (axisLen < 1e-12) {
    return [[-u[0],-u[1],-u[2]], [-v[0],-v[1],-v[2]]];
  }

  const ax = [axisRaw[0]/axisLen, axisRaw[1]/axisLen, axisRaw[2]/axisLen];
  const angle = Math.acos(d);
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  function rotVec(vec) {
    const dt = v3dot(ax, vec);
    const cr = v3cross(ax, vec);
    return [
      vec[0]*c + cr[0]*s + ax[0]*dt*(1-c),
      vec[1]*c + cr[1]*s + ax[1]*dt*(1-c),
      vec[2]*c + cr[2]*s + ax[2]*dt*(1-c),
    ];
  }

  return [v3norm(rotVec(u)), v3norm(rotVec(v))];
}

// ---------------------------------------------------------------------------
// Blade-width scale at a given node along a chain.
//
// bladeWidth:  base half-width in world units.
// bladeTaper:  [0,1] — 0 = parallel-sided, 1 = needle tip (zero at tip).
// swayBase:    [0,1] normalized height along the blade (0=base, 1=tip).
// ---------------------------------------------------------------------------
function widthAt(bladeWidth, bladeTaper, swayBase) {
  return bladeWidth * (1 - bladeTaper * swayBase);
}

// ---------------------------------------------------------------------------
// Normal up-bias: geometry-level blend toward world-up.
// Set to 0.0 — the fragment shader now owns the canopy bias (k=0.65 in view
// space), so applying it again here would double the effect and over-flatten
// the shading gradient.  The lean-derived geometric normal is preserved in full
// so the per-blade sparkle / directional signal reaches the fragment shader.
// ---------------------------------------------------------------------------
const NORMAL_UP_BIAS = 0.0;

// Width-fan strength: how far the left/right edge normals tilt outward away
// from the blade centre, as if the ribbon were a shallow half-cylinder.
// 0 = no fan (all verts same normal), 1 = 90° tilt at the edges.
// 0.35 gives a gentle cross-blade gradient without looking convex.
const NORMAL_WIDTH_FAN = 0.35;

/**
 * Compute a grass-appropriate vertex normal.
 *
 * Takes the raw face normal (`faceNorm`), the blade's width axis (`frameU`,
 * pointing left→right), and a `widthT` in [-1, +1] (-1=left edge, 0=centre,
 * +1=right edge), then:
 *   1. Fans the normal across the blade width (half-cylinder approximation).
 *   2. Biases the result toward world-up to unify shading across blades with
 *      different orientations and eliminate the per-blade sparkle.
 *
 * Returns a normalised [nx, ny, nz].
 */
function bladeNormal(faceNorm, frameU, widthT) {
  // Step 1 — cross-blade fan: tilt the face normal toward the width axis
  // direction at each edge.  widthT=-1 tilts toward -frameU, +1 toward +frameU.
  // lerp: normal = faceNorm + widthT * NORMAL_WIDTH_FAN * frameU
  const fanX = faceNorm[0] + widthT * NORMAL_WIDTH_FAN * frameU[0];
  const fanY = faceNorm[1] + widthT * NORMAL_WIDTH_FAN * frameU[1];
  const fanZ = faceNorm[2] + widthT * NORMAL_WIDTH_FAN * frameU[2];

  // Step 2 — up-bias: lerp between the fanned normal and world-up.
  // This is the primary fix for the per-blade brightness flicker.
  const bx = fanX * (1 - NORMAL_UP_BIAS);
  const by = fanY * (1 - NORMAL_UP_BIAS) + NORMAL_UP_BIAS;  // world-up = (0,1,0)
  const bz = fanZ * (1 - NORMAL_UP_BIAS);

  return v3norm([bx, by, bz]);
}

// ---------------------------------------------------------------------------
// Per-node AO: base-darker, tip-brighter. Floor raised to 0.55.
// The old 0.35 floor crushed base-of-blade darkness too far once the fragment
// shader's canopy bias keeps all normals above the horizon.  0.55 keeps the
// base readable while still giving a visible gradient to the tip.
// ---------------------------------------------------------------------------
function aoAt(swayBase) {
  // Darker at the base (swayBase=0), brighter at tip (swayBase=1).
  // Linear ramp from 0.55 at base to 1.0 at tip.
  return 0.55 + swayBase * 0.45;
}

// ---------------------------------------------------------------------------
// Simple deterministic hash for colorSeed (no rng draws).
// Maps (bladeIndex) → [0, 1].
// ---------------------------------------------------------------------------
function bladeColorSeed(bladeIndex, structuralSeed) {
  // Low-quality but stable hash — just needs to scatter nicely in [0,1].
  const h = Math.abs(Math.sin(bladeIndex * 2.3999 + (structuralSeed >>> 0) * 0.000001 + 1.6180));
  return h - Math.floor(h);
}

// ---------------------------------------------------------------------------
// buildBladeGeometry
// ---------------------------------------------------------------------------

export function buildBladeGeometry(graph, opts = {}) {
  const { nodes, bones } = graph;

  const bladeWidth     = opts.bladeWidth     !== undefined ? opts.bladeWidth     : 0.015;
  const bladeTaper     = opts.bladeTaper     !== undefined ? opts.bladeTaper     : 0;
  const midribStrength = opts.midribStrength !== undefined ? opts.midribStrength : 0;
  const bladeRaggedness = opts.bladeRaggedness !== undefined ? opts.bladeRaggedness : 0;

  // Use midrib vertices if midribStrength > 0.
  const useMidrib = midribStrength > 0;

  // Guard: empty graph.
  if (!bones || bones.length === 0 || !nodes || nodes.length === 0) {
    return _emptyResult(nodes ? nodes.length : 0);
  }

  // -------------------------------------------------------------------------
  // Build children map: childrenOf[i] = list of child node indices.
  // -------------------------------------------------------------------------
  const childrenOf = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) childrenOf[i] = [];

  for (const bone of bones) {
    childrenOf[bone.a].push(bone.b);
  }

  // -------------------------------------------------------------------------
  // Identify blade chains.
  //
  // A grass graph has all nodes at branchLevel 0 (no recursive branching).
  // Each blade is a linear chain from a root node (parentIdx === -1) to its tip.
  // We walk chains by finding the blade-root nodes (parentIdx === -1) and
  // following the single-child path to the terminal tip.
  // -------------------------------------------------------------------------
  const chains = [];  // each chain is an ordered array of node indices

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parentIdx !== -1) continue;  // not a blade base

    const chain = [i];
    let cur = i;
    while (childrenOf[cur].length === 1) {
      cur = childrenOf[cur][0];
      chain.push(cur);
    }
    // chains with fewer than 2 nodes can't produce geometry, but we still
    // record them so nodeToBlade is populated correctly.
    chains.push(chain);
  }

  // -------------------------------------------------------------------------
  // Build nodeToBlade: node index → blade (chain) index, -1 = not rendered.
  // -------------------------------------------------------------------------
  const nodeToBlade = new Int32Array(nodes.length).fill(-1);
  for (let ci = 0; ci < chains.length; ci++) {
    for (const ni of chains[ci]) {
      nodeToBlade[ni] = ci;
    }
  }

  // -------------------------------------------------------------------------
  // Vertex/triangle count per chain.
  //
  // Chain of N nodes:
  //   without midrib: V = 2*(N-1) + 1,  T = 2*(N-1) - 1
  //     (2*(N-2) quad tris + 1 tip tri; tip has single front-face tri since
  //      side:DoubleSide renders the back — removing the coplanar reverse tri
  //      that was causing z-fighting and back-face normal flip)
  //   with midrib:    V = 3*(N-1) + 1,  T = 4*(N-2) + 2  (N >= 2)
  //
  // Chain of 1 node (degenerate): no geometry.
  // -------------------------------------------------------------------------
  const vertsPerRing = useMidrib ? 3 : 2;

  let totalV = 0;
  let totalT = 0;

  for (const chain of chains) {
    const N = chain.length;
    if (N < 2) continue;
    totalV += vertsPerRing * (N - 1) + 1;  // non-tip rings + apex
    if (useMidrib) {
      totalT += N >= 3 ? 4 * (N - 2) + 2 : 2;  // quads + tip fan
    } else {
      totalT += 2 * (N - 1) - 1;  // quad tris + 1 tip tri (no coplanar reverse)
    }
  }

  // -------------------------------------------------------------------------
  // Allocate output buffers.
  // -------------------------------------------------------------------------
  const positions   = new Float32Array(totalV * 3);
  const normals     = new Float32Array(totalV * 3);
  const uvs         = new Float32Array(totalV * 2);
  const ao          = new Float32Array(totalV);
  const swayFactor  = new Float32Array(totalV);
  const colorSeed   = new Float32Array(totalV);
  const indices     = new Uint32Array(totalT * 3);

  // Bounds tracking.
  let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
  let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;

  let vCursor = 0;
  let iCursor = 0;  // triangle count (indices filled as iCursor*3)

  // -------------------------------------------------------------------------
  // Write a single vertex.
  // -------------------------------------------------------------------------
  function writeVertex(px, py, pz, nx, ny, nz, u, v, aoVal, swayVal, cseed) {
    const vi = vCursor;
    positions[vi*3]   = px;
    positions[vi*3+1] = py;
    positions[vi*3+2] = pz;
    normals[vi*3]   = nx;
    normals[vi*3+1] = ny;
    normals[vi*3+2] = nz;
    uvs[vi*2]   = u;
    uvs[vi*2+1] = v;
    ao[vi]         = aoVal;
    swayFactor[vi] = swayVal;
    colorSeed[vi]  = cseed;
    if (px < bMinX) bMinX = px; if (px > bMaxX) bMaxX = px;
    if (py < bMinY) bMinY = py; if (py > bMaxY) bMaxY = py;
    if (pz < bMinZ) bMinZ = pz; if (pz > bMaxZ) bMaxZ = pz;
    vCursor++;
    return vi;
  }

  // -------------------------------------------------------------------------
  // Emit one triangle (CCW winding, front face = ribbon face normal outward).
  // -------------------------------------------------------------------------
  function emitTri(a, b, c) {
    const base = iCursor * 3;
    indices[base]   = a;
    indices[base+1] = b;
    indices[base+2] = c;
    iCursor++;
  }

  // -------------------------------------------------------------------------
  // Emit geometry per chain.
  // -------------------------------------------------------------------------
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const N = chain.length;
    if (N < 2) continue;

    // Per-blade color seed (constant for all vertices in this blade).
    const structuralSeed = (graph.meta && graph.meta.structuralSeed) ? graph.meta.structuralSeed : ci;
    const cseed = bladeColorSeed(ci, structuralSeed);

    // Compute the initial tangent from the first two nodes.
    let tangent = v3norm(v3sub(nodes[chain[1]].pos, nodes[chain[0]].pos));
    if (v3len(tangent) < 0.5) tangent = [0, 1, 0];

    // ---------------------------------------------------------------------------
    // FIX 1 — lean-derived face normal (replaces world-X seed).
    //
    // The blade's broad face should face the direction the blade bows (leans).
    // Seed frameNorm from the horizontal component of the tip→base lean vector
    // so every blade faces its own lean direction, not the fixed world-X axis.
    //
    // DEGENERATE CASE (dead-upright blade, |horizontalLean| < 1e-4):
    //   Fall back to a deterministic per-blade azimuth derived from
    //   (structuralSeed ^ ci * 2654435761) — a Knuth multiplicative hash.
    //   This guarantees varied, orientation-independent facing with NO extra
    //   rng draws, preserving full determinism.
    // ---------------------------------------------------------------------------
    const basePos = nodes[chain[0]].pos;
    const tipPos  = nodes[chain[N - 1]].pos;
    const leanRaw = v3sub(tipPos, basePos);
    const hLean   = [leanRaw[0], 0, leanRaw[2]];  // horizontal component
    const hLeanLen = v3len(hLean);

    let frameNorm;
    if (hLeanLen > 1e-4) {
      // Normal case: face the horizontal lean direction.
      frameNorm = [hLean[0] / hLeanLen, 0, hLean[2] / hLeanLen];
    } else {
      // Dead-upright blade: deterministic azimuth from blade index + structuralSeed.
      const seed = (((structuralSeed >>> 0) ^ (ci * 2654435761)) >>> 0) * 2.3283064365e-10;
      const az   = seed * Math.PI * 2;
      frameNorm  = [Math.cos(az), 0, Math.sin(az)];
    }

    // Width axis = tangent × frameNorm (right-hand rule; lies across the blade).
    let frameU = v3norm(v3cross(tangent, frameNorm));
    // Re-orthogonalize frameNorm in case tangent and frameNorm were not perfectly
    // perpendicular (small lean) — frameNorm = frameU × tangent ensures all three
    // axes form a valid frame.
    frameNorm = v3norm(v3cross(frameU, tangent));

    let prevTangent = tangent;

    // Accumulated arc length along the chain (for UV v-coordinate).
    let arcLen = 0;
    let totalArcLen = 0;
    for (let ni = 0; ni < N - 1; ni++) {
      totalArcLen += v3len(v3sub(nodes[chain[ni+1]].pos, nodes[chain[ni]].pos));
    }
    if (totalArcLen < 1e-12) totalArcLen = 1;

    // Ring vertex base indices (first vertex of each non-tip ring).
    const ringBases = new Int32Array(N - 1);

    // Emit non-tip nodes as ribbon rings.
    for (let ni = 0; ni < N - 1; ni++) {
      const nodeIdx  = chain[ni];
      const node     = nodes[nodeIdx];
      const swayVal  = node.swayBase !== undefined ? node.swayBase : ni / (N - 1);
      const aoVal    = aoAt(swayVal);
      const halfW    = Math.max(1e-5, widthAt(bladeWidth, bladeTaper, swayVal));

      // Update parallel-transport frame (after the first node).
      if (ni > 0) {
        const prevPos = nodes[chain[ni-1]].pos;
        const curPos  = node.pos;
        let newTangent;
        if (ni < N - 1) {
          const nextPos  = nodes[chain[ni+1]].pos;
          const incoming = v3norm(v3sub(curPos, prevPos));
          const outgoing = v3norm(v3sub(nextPos, curPos));
          const avg = v3norm([incoming[0]+outgoing[0], incoming[1]+outgoing[1], incoming[2]+outgoing[2]]);
          newTangent = v3len(avg) < 0.5 ? incoming : v3norm(avg);
        } else {
          newTangent = v3norm(v3sub(curPos, prevPos));
        }

        [frameU, frameNorm] = transportFrame(prevTangent, newTangent, frameU, frameNorm);
        prevTangent = newTangent;

        arcLen += v3len(v3sub(curPos, prevPos));
      }

      // v-coordinate: normalized arc length.
      const vCoord = arcLen / totalArcLen;

      // Apply raggedness as independent deterministic jitters on each edge.
      // Using distinct hashes for left and right so the centerline stays on the
      // node path (symmetric perturbation: each edge moves independently by its
      // own signed amount, the average remains halfW).
      let leftJitter  = 0;
      let rightJitter = 0;
      if (bladeRaggedness > 0) {
        leftJitter  = Math.sin(nodeIdx * 7.3  + ci * 4.1) * bladeRaggedness * halfW;
        rightJitter = Math.sin(nodeIdx * 11.7 + ci * 6.3) * bladeRaggedness * halfW;
      }

      const pos  = node.pos;

      // Left vertex: pos - (halfW + leftJitter) * frameU
      // Right vertex: pos + (halfW + rightJitter) * frameU
      // Each edge is independently perturbed; the centerline stays on node.pos.
      const leftOffset  = halfW + leftJitter;
      const rightOffset = halfW + rightJitter;

      const lx = pos[0] - leftOffset  * frameU[0];
      const ly = pos[1] - leftOffset  * frameU[1];
      const lz = pos[2] - leftOffset  * frameU[2];

      const rx = pos[0] + rightOffset * frameU[0];
      const ry = pos[1] + rightOffset * frameU[1];
      const rz = pos[2] + rightOffset * frameU[2];

      ringBases[ni] = vCursor;

      // Compute per-vertex normals with up-bias and cross-blade fan.
      // widthT: -1 = left edge, 0 = centre (midrib), +1 = right edge.
      const nLeft   = bladeNormal(frameNorm, frameU, -1);
      const nCentre = bladeNormal(frameNorm, frameU,  0);
      const nRight  = bladeNormal(frameNorm, frameU, +1);

      if (useMidrib) {
        // Midrib vertex: at node.pos, but with a crease offset along face normal
        // (sinks the midrib slightly inward, creating the V-fold crease).
        // The crease depth is midribStrength * halfW.
        const creaseDepth = midribStrength * halfW;
        const mx = pos[0] - creaseDepth * frameNorm[0];
        const my = pos[1] - creaseDepth * frameNorm[1];
        const mz = pos[2] - creaseDepth * frameNorm[2];

        // LEFT, MIDRIB, RIGHT
        writeVertex(lx, ly, lz,  nLeft[0],   nLeft[1],   nLeft[2],   0.0, vCoord, aoVal, swayVal, cseed);
        writeVertex(mx, my, mz,  nCentre[0], nCentre[1], nCentre[2], 0.5, vCoord, aoVal, swayVal, cseed);
        writeVertex(rx, ry, rz,  nRight[0],  nRight[1],  nRight[2],  1.0, vCoord, aoVal, swayVal, cseed);
      } else {
        // LEFT, RIGHT
        writeVertex(lx, ly, lz,  nLeft[0],  nLeft[1],  nLeft[2],  0.0, vCoord, aoVal, swayVal, cseed);
        writeVertex(rx, ry, rz,  nRight[0], nRight[1], nRight[2], 1.0, vCoord, aoVal, swayVal, cseed);
      }
    }

    // Emit apex vertex at tip node.
    // The apex is the centre of the tip fan, so widthT=0 (centre normal).
    const tipNodeIdx = chain[N - 1];
    const tipNode    = nodes[tipNodeIdx];
    const tipSway    = tipNode.swayBase !== undefined ? tipNode.swayBase : 1.0;
    const tipAO      = aoAt(tipSway);
    const tipNorm    = bladeNormal(frameNorm, frameU, 0);
    const apexVert   = writeVertex(
      tipNode.pos[0], tipNode.pos[1], tipNode.pos[2],
      tipNorm[0], tipNorm[1], tipNorm[2],
      0.5, 1.0, tipAO, tipSway, cseed
    );

    // Emit triangles connecting the ribbon rings and the apex.
    if (!useMidrib) {
      // Topology: 2 verts per ring (L=base, R=base+1).
      // Between ring[ni] and ring[ni+1]: quad → 2 tris.
      //   L[ni], R[ni], R[ni+1]
      //   L[ni], R[ni+1], L[ni+1]
      // Tip fan from ring[N-2] to apex:
      //   L[N-2], R[N-2], apex  (but we need CCW from outside)
      //   Actually: L[N-2], apex, R[N-2] gives front-face outward if
      //   norm is pointing toward viewer — use standard CCW rule.

      for (let ri = 0; ri < N - 2; ri++) {
        const rb0 = ringBases[ri];
        const rb1 = ringBases[ri + 1];
        const L0 = rb0, R0 = rb0 + 1;
        const L1 = rb1, R1 = rb1 + 1;
        // Quad strip: CCW from front face (frameNorm side).
        //   Front face: norm points in +frameNorm direction.
        //   Looking from +frameNorm: L is to the left, R to the right.
        //   Lower ring: L0, R0; Upper ring: L1, R1.
        //   CCW from outside: L0→R0→R1 and L0→R1→L1
        emitTri(L0, R0, R1);
        emitTri(L0, R1, L1);
      }

      // Tip fan: last ring (N-2) to apex.
      // One triangle only — side:DoubleSide renders the back face; the coplanar
      // reversed triangle would z-fight and flip the normal on the back face.
      if (N >= 2) {
        const lastRb = ringBases[N - 2];
        const L = lastRb, R = lastRb + 1;
        emitTri(L, R, apexVert);
      }
    } else {
      // Topology: 3 verts per ring (L=base, M=base+1, R=base+2).
      // Between ring[ni] and ring[ni+1]: two quads → 4 tris.
      //   Left sub-ribbon (L→M):
      //     L[ni], M[ni], M[ni+1]
      //     L[ni], M[ni+1], L[ni+1]
      //   Right sub-ribbon (M→R):
      //     M[ni], R[ni], R[ni+1]
      //     M[ni], R[ni+1], M[ni+1]
      // Tip fan: 2 tris.
      //   L[N-2], M[N-2], apex
      //   M[N-2], R[N-2], apex

      for (let ri = 0; ri < N - 2; ri++) {
        const rb0 = ringBases[ri];
        const rb1 = ringBases[ri + 1];
        const L0 = rb0, M0 = rb0+1, R0 = rb0+2;
        const L1 = rb1, M1 = rb1+1, R1 = rb1+2;
        // Left sub-ribbon
        emitTri(L0, M0, M1);
        emitTri(L0, M1, L1);
        // Right sub-ribbon
        emitTri(M0, R0, R1);
        emitTri(M0, R1, M1);
      }

      // Tip fan.
      if (N >= 2) {
        const lastRb = ringBases[N - 2];
        const L = lastRb, M = lastRb+1, R = lastRb+2;
        emitTri(L, M, apexVert);
        emitTri(M, R, apexVert);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bounds.
  // -------------------------------------------------------------------------
  let bounds;
  if (vCursor === 0) {
    bounds = { min: [0,0,0], max: [0,0,0] };
  } else {
    bounds = {
      min: [bMinX, bMinY, bMinZ],
      max: [bMaxX, bMaxY, bMaxZ],
    };
  }

  return {
    positions:     positions.subarray(0, vCursor * 3),
    normals:       normals.subarray(0, vCursor * 3),
    uvs:           uvs.subarray(0, vCursor * 2),
    ao:            ao.subarray(0, vCursor),
    swayFactor:    swayFactor.subarray(0, vCursor),
    colorSeed:     colorSeed.subarray(0, vCursor),
    indices:       indices.subarray(0, iCursor * 3),
    vertexCount:   vCursor,
    triangleCount: iCursor,
    bounds,
    nodeToBlade,
  };
}

// ---------------------------------------------------------------------------
// Empty result helper
// ---------------------------------------------------------------------------
function _emptyResult(nodeCount) {
  return {
    positions:     new Float32Array(0),
    normals:       new Float32Array(0),
    uvs:           new Float32Array(0),
    ao:            new Float32Array(0),
    swayFactor:    new Float32Array(0),
    colorSeed:     new Float32Array(0),
    indices:       new Uint32Array(0),
    vertexCount:   0,
    triangleCount: 0,
    bounds: { min: [0,0,0], max: [0,0,0] },
    nodeToBlade:   new Int32Array(nodeCount || 0).fill(-1),
  };
}

// ---------------------------------------------------------------------------
// COLOR TINT GLSL — injected into vertex shader via onBeforeCompile.
//
// Reads the per-vertex colorSeed float attribute, applies colorVariation
// to compute a per-blade LINEAR RGB albedo that is written into vColor,
// which three.js color_fragment multiplies into diffuseColor.rgb when
// vertexColors:true is set.
//
// LINEAR albedo (no HSL): vertex colors are not sRGB-decoded by the GPU,
// so we write linear values directly.  The OutputPass/sRGB conversion later
// handles gamma.  Base→tip gradient is a linear mix in RGB space.
// ---------------------------------------------------------------------------

const COLOR_ATTRIBUTE_DECL = /* glsl */`
attribute float colorSeed;
attribute float ao;
attribute float aColorJitter;
`;

const COLOR_UNIFORM_DECLS = /* glsl */`
uniform float uPigment;
uniform float uColorVariation;
`;

// bladeColorTint — linear RGB albedo, natural lawn/meadow palette.
//
// Parameters:
//   seed        — per-blade colorSeed in [0,1], drives per-blade multiplier variation.
//   swayFrac    — per-vertex swayFactor in [0,1]: 0=base, 1=tip, drives tip gradient.
//   clumpJitter — aColorJitter instanced float (default 0 when absent), signed [-1,1],
//                 applies a small per-clump multiplier so neighbouring clumps differ.
//
// Base colour: linear vec3(0.10, 0.22, 0.07) — dark green.
// Tip colour:  linear vec3(0.20, 0.30, 0.10) — lighter yellow-green.
// Per-blade variation: small multiplicative offset from colorSeed × uColorVariation.
// Per-clump variation: small multiplicative offset from aColorJitter.
const COLOR_FUNCTION_GLSL = /* glsl */`
vec3 bladeColorTint(float seed, float swayFrac, float clumpJitter) {
    // Linear base → tip gradient (RGB, no HSL conversion needed).
    vec3 baseCol = vec3(0.10, 0.22, 0.07);
    vec3 tipCol  = vec3(0.20, 0.30, 0.10);
    vec3 albedo  = mix(baseCol, tipCol, swayFrac);

    // Per-blade multiplier: small spread around 1.0 driven by colorSeed.
    // Scaled by uColorVariation so the spread can be dialled in from the UI.
    float bladeHueDelta = (seed - 0.5) * uColorVariation * 0.10;
    albedo *= 1.0 + bladeHueDelta;

    // Per-clump multiplier: aColorJitter in [-1,1] mapped to a ±0.05 offset.
    float jitterClamped = clamp(clumpJitter, -1.0, 1.0);
    float clumpHueDelta = jitterClamped * 0.05;
    albedo *= 1.0 + clumpHueDelta;

    return max(albedo, vec3(0.0));
}
`;

// vBladeTint was removed — it was declared and written in the vertex shader
// but never read in any fragment shader.  The real color path is vColor.
// COLOR_VERTEX_WRITE is kept for documentation; the actual call is inlined in
// the onBeforeCompile replacement with the three arguments (seed, swayFrac, clumpJitter).
const COLOR_VERTEX_WRITE = /* glsl */`
bladeColorTint(colorSeed, aSwayFactor, aColorJitter);
`;

// ---------------------------------------------------------------------------
// FRAGMENT SHADER — canopy shading model.
//
// Injected via onBeforeCompile into the fragment shader to implement:
//   (1) Canopy-biased shading normal: flip for back face, blend toward view-space
//       up by k=0.65, so IBL + direct diffuse both use the biased normal.
//   (2) Wrap / half-Lambert diffuse: (dot(N,L)+0.5)/1.5 squared removes hard
//       terminator while keeping physical energy near-correct.
//   (3) Thin-blade translucency: additive back-lighting (view through thin leaf)
//       gated to tips via vSwayFactor (passed as a varying from the vertex shader).
//
// CRITICAL: 'normal' in MeshStandardMaterial fragment is VIEW-SPACE, not world-space.
// "Up" must be computed as viewMatrix * (0,1,0,0) in view-space.
// ---------------------------------------------------------------------------

// Varying declaration injected into the vertex shader so vSwayFactor reaches
// the fragment shader.  aSwayFactor is already declared as an attribute above;
// we only need to declare the varying and write it.
const GRASS_VARYING_DECL_VERT = /* glsl */`
varying float vSwayFactor;
`;

const GRASS_VARYING_WRITE_VERT = /* glsl */`
vSwayFactor = aSwayFactor;
`;

// Fragment-shader additions injected after #include <normal_fragment_begin>:
//   (1) Flip + up-bias in view space.
//   (2) Wrap/half-Lambert remap for direct diffuse (additive; replaces N·L at
//       lights_fragment_end via added terms to reflectedLight.directDiffuse).
// The fragment shader declaration block (inserted at #include <common>):
const GRASS_FRAG_DECL = /* glsl */`
varying float vSwayFactor;
`;

// The normal-bias injection (after #include <normal_fragment_begin>):
//   • Back-face flip is NOT done here — side:DoubleSide already makes three.js
//     apply `normal *= faceDirection` in normal_fragment_begin, so re-flipping
//     would double-flip and un-flip back faces.
//   • Blend toward view-space up (k=0.65).  viewMatrix is available as a built-in
//     in three.js fragment shaders.
const GRASS_NORMAL_BIAS_GLSL = /* glsl */`
// --- grass canopy normal bias ---
// viewMatrix is available in three.js fragment shaders.
// NOTE: 'normal' is already backface-flipped here — side:DoubleSide makes
// three.js apply (normal *= faceDirection) in normal_fragment_begin, so we
// must NOT flip again (that would un-flip back faces). Just bias toward up.
vec3 _upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
vec3 _Nbent = normalize(mix(normalize(normal), _upView, 0.65));
normal = _Nbent;
// --- end grass canopy normal bias ---
`;

// The wrap + translucency injection (after #include <lights_fragment_end>):
//   • Wrap/half-Lambert remaps the direct diffuse contribution so it never crushes
//     to black; the term is additive on top of the standard PBR result, scaled so
//     the total is energy-plausible (~1.0 at 90° vs PBR's 0).
//   • Thin-blade translucency: view-through scatter at tips.
//
// We add corrective wrap and translucency as additive terms to
// reflectedLight.directDiffuse.  The standard PBR clamp remains; we just
// add the soft shadow-side fill and tip glow on top.
const GRASS_LIGHTING_GLSL = /* glsl */`
// --- grass wrap diffuse + translucency ---
#if NUM_DIR_LIGHTS > 0
{
    // Wrap / half-Lambert for the first directional light (sun).
    DirectionalLight _dirLight = directionalLights[0];
    // directionalLights[].direction is VIEW-SPACE in three.js.
    vec3 _L = normalize(_dirLight.direction);
    float _wrapDot = (dot(normal, _L) + 0.5) / 1.5;
    float _wrapDiff = max(_wrapDot, 0.0) * max(_wrapDot, 0.0);
    // Standard PBR already computed max(0,N·L); subtract it and add wrap term
    // so we don't double-count.  Scale by diffuseColor so albedo is respected.
    float _stdDot = max(dot(normal, _L), 0.0);
    float _wrapExtra = (_wrapDiff - _stdDot * _stdDot) * 0.6;
    reflectedLight.directDiffuse += _dirLight.color * diffuseColor.rgb * max(_wrapExtra, 0.0);

    // Thin-blade translucency: additive backlight gated to tips.
    vec3 _V = normalize(vViewPosition);
    float _backDot = max(dot(_V, -_L), 0.0);
    float _trans = pow(_backDot, 4.0) * 0.5;
    vec3 _transColor = _dirLight.color * vec3(0.55, 0.75, 0.30) * _trans * vSwayFactor;
    reflectedLight.directDiffuse += _transColor;
}
#endif
// --- end grass wrap diffuse + translucency ---
`;

// ---------------------------------------------------------------------------
// createBladeMaterial(THREE, opts)
//
// Creates a MeshStandardMaterial with:
//   - onBeforeCompile: injects windOffset(worldPos, aSwayFactor) + aSwayFactor
//     attribute declaration into the vertex shader.
//   - Per-blade color tint: colorSeed attribute + uPigment/uColorVariation uniforms
//     drive a linear RGB albedo written into vColor, which three.js color_fragment
//     multiplies into diffuseColor.rgb (vertexColors:true path).
//   - Canopy shading: view-space up-bias (k=0.65), wrap/half-Lambert diffuse,
//     thin-blade translucency — all injected into the fragment shader.
//   - Double-sided.
//   - No map texture (ribbon geometry is the visual asset).
//
// opts:
//   windGlsl:       { WIND_UNIFORM_DECLS, WIND_FUNCTION_GLSL, WIND_UNIFORM_DEFAULTS }
//                   Pass the imported windGlsl module exports. If omitted, the
//                   material is still valid but won't animate with wind.
//   pigment:        number [0,1] — hue on colorRamp (default: 0.30, grass green).
//   colorVariation: number [0,1] — per-blade RGB spread (default: 0).
// ---------------------------------------------------------------------------

export function createBladeMaterial(THREE, opts = {}) {
  const {
    windGlsl,
    pigment = 0.30,
    colorVariation = 0,
  } = opts;

  // vertexColors:true makes three.js emit #define USE_COLOR → declares
  // "attribute vec3 color;" and multiplies diffuseColor.rgb by vColor.
  // We hijack vColor by writing our blade tint into it in onBeforeCompile.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,  // neutral white: the tint comes entirely from vColor
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,
  });

  // Store color uniforms on userData, mirroring the wind uniforms pattern.
  // viewer.js updates these every setPlant call.
  mat.userData.colorUniforms = {
    uPigment:        { value: pigment },
    uColorVariation: { value: colorVariation },
  };

  if (windGlsl) {
    const { WIND_UNIFORM_DECLS, WIND_FUNCTION_GLSL, WIND_UNIFORM_DEFAULTS } = windGlsl;

    // Copy defaults into material uniforms for the wiring layer (viewer).
    mat.userData.windUniforms = {
      uTime:         { value: WIND_UNIFORM_DEFAULTS.uTime },
      uWindStrength: { value: WIND_UNIFORM_DEFAULTS.uWindStrength },
      uWindDir:      { value: new THREE.Vector2(...WIND_UNIFORM_DEFAULTS.uWindDir) },
    };

    mat.onBeforeCompile = function(shader) {
      // Inject wind + color uniforms into the shader.
      Object.assign(shader.uniforms, mat.userData.windUniforms);
      Object.assign(shader.uniforms, mat.userData.colorUniforms);

      // -----------------------------------------------------------------------
      // VERTEX SHADER
      // -----------------------------------------------------------------------

      // Inject into the vertex shader preamble (after #include <common>):
      //   - aSwayFactor attribute (wind sway height 0..1)
      //   - colorSeed attribute (per-blade deterministic hash in [0,1])
      //   - wind uniform declarations + windOffset function
      //   - color uniform declarations + bladeColorTint function
      //   - vSwayFactor varying declaration (forwarded to fragment for translucency)
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        [
          '#include <common>',
          'attribute float aSwayFactor;',
          COLOR_ATTRIBUTE_DECL,
          WIND_UNIFORM_DECLS,
          WIND_FUNCTION_GLSL,
          COLOR_UNIFORM_DECLS,
          COLOR_FUNCTION_GLSL,
          GRASS_VARYING_DECL_VERT,
        ].join('\n')
      );

      // Compute per-blade world position, apply wind, and write vColor.
      //
      // three.js r160 project_vertex applies instanceMatrix BEFORE modelMatrix:
      //   gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1)
      // So the true world position under instancing is:
      //   modelMatrix * instanceMatrix * transformed
      // We guard with #ifdef USE_INSTANCING to keep the specimen path (identity
      // instanceMatrix) identical to the old behavior.
      //
      // vColor is the attribute three.js declares when vertexColors:true is set.
      // We override it by writing our tint — the #define USE_COLOR path in
      // color_fragment reads vColor, so this becomes the diffuse multiplier.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        [
          '// --- blade wind + color tint ---',
          'vec4 _wp = vec4(transformed, 1.0);',
          '#ifdef USE_INSTANCING',
          '  _wp = instanceMatrix * _wp;',
          '#endif',
          '_wp = modelMatrix * _wp;',
          'vec3 _wind = windOffset(_wp.xyz, aSwayFactor);',
          '#ifdef USE_INSTANCING',
          '  _wind = inverse(mat3(instanceMatrix)) * _wind;',
          '#endif',
          'transformed += _wind;',
          'vColor.rgb = bladeColorTint(colorSeed, aSwayFactor, aColorJitter) * ao;',
          GRASS_VARYING_WRITE_VERT,
          '// --- end blade ---',
          '#include <project_vertex>',
        ].join('\n')
      );

      // -----------------------------------------------------------------------
      // FRAGMENT SHADER
      // Only runs when shader.fragmentShader is present (skipped by tests that
      // only provide vertexShader, and by the depth material which has no frag).
      // -----------------------------------------------------------------------
      if (shader.fragmentShader !== undefined) {
        // Inject fragment varying declaration after #include <common>.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          [
            '#include <common>',
            GRASS_FRAG_DECL,
          ].join('\n')
        );

        // Inject canopy-biased normal (view-space up-bias k=0.65) immediately
        // after #include <normal_fragment_begin> so all subsequent lighting
        // (RE_Direct, IBL) uses the biased normal.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_begin>',
          [
            '#include <normal_fragment_begin>',
            GRASS_NORMAL_BIAS_GLSL,
          ].join('\n')
        );

        // Inject wrap-diffuse and translucency after #include <lights_fragment_end>
        // so they add on top of the standard PBR result.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_fragment_end>',
          [
            '#include <lights_fragment_end>',
            GRASS_LIGHTING_GLSL,
          ].join('\n')
        );
      }

      // Store reference so uniforms can be updated per-frame.
      mat.userData.compiledShader = shader;
    };

    // Force recompile flag.
    mat.needsUpdate = true;
  }

  return mat;
}

// ---------------------------------------------------------------------------
// createBladeDepthMaterial(THREE, opts)
//
// MeshDepthMaterial with the same wind injection (for shadow casting).
// The depth material doesn't run onBeforeCompile by default in all three.js
// versions the same way — we follow the same pattern to be safe.
// Color uniforms are NOT needed here (depth pass doesn't tint).
// ---------------------------------------------------------------------------

export function createBladeDepthMaterial(THREE, opts = {}) {
  const { windGlsl } = opts;

  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  });

  if (windGlsl) {
    const { WIND_UNIFORM_DECLS, WIND_FUNCTION_GLSL, WIND_UNIFORM_DEFAULTS } = windGlsl;

    mat.userData.windUniforms = {
      uTime:         { value: WIND_UNIFORM_DEFAULTS.uTime },
      uWindStrength: { value: WIND_UNIFORM_DEFAULTS.uWindStrength },
      uWindDir:      { value: new THREE.Vector2(...WIND_UNIFORM_DEFAULTS.uWindDir) },
    };

    mat.onBeforeCompile = function(shader) {
      Object.assign(shader.uniforms, mat.userData.windUniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        [
          '#include <common>',
          'attribute float aSwayFactor;',
          WIND_UNIFORM_DECLS,
          WIND_FUNCTION_GLSL,
        ].join('\n')
      );

      // Apply the same instanceMatrix-aware world position computation as the
      // main material so shadows match blade positions exactly.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        [
          '// --- blade wind (depth) ---',
          'vec4 _wp = vec4(transformed, 1.0);',
          '#ifdef USE_INSTANCING',
          '  _wp = instanceMatrix * _wp;',
          '#endif',
          '_wp = modelMatrix * _wp;',
          'vec3 _wind = windOffset(_wp.xyz, aSwayFactor);',
          '#ifdef USE_INSTANCING',
          '  _wind = inverse(mat3(instanceMatrix)) * _wind;',
          '#endif',
          'transformed += _wind;',
          '// --- end blade ---',
          '#include <project_vertex>',
        ].join('\n')
      );

      mat.userData.compiledShader = shader;
    };

    mat.needsUpdate = true;
  }

  return mat;
}
