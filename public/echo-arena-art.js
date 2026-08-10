/**
 * Echo Arena cosmetic drawing, for the dashboard.
 *
 * A straight port of the game client's `app/cosmetics-render.ts` — same geometry, same numbers, same
 * two-colour convention — so the Store catalogue page shows an operator the *actual* hull, wake and
 * round an item draws rather than a gradient standing in for one. Colour alone cannot answer the
 * question the page exists to answer ("what is this thing?"), and every art key here is a shape the
 * operator can pick but could not see.
 *
 * **This file is a copy, and copies drift.** The game is its own repository and the backend ships
 * without it, so there is no import to reach for; the alternative to a copy is no drawing at all. If
 * a silhouette changes in `cosmetics-render.ts`, it has to be changed here too — the art keys are a
 * closed set (`COSMETIC_ART` in `src/game-config/game-defaults.ts`), so the drift is bounded and
 * visible: an unknown key falls back to the first drawing on its shelf, exactly as the client does.
 *
 * Conventions carried over unchanged:
 *
 * - **Local space.** The caller has translated to the ship, rotated to its heading, and set
 *   `globalAlpha` / `shadowColor`. +X is forward, the origin is the centre of mass.
 * - **Rank is information.** `rank` is the number of upgrade cards installed (0–8) and every hull
 *   grows visibly with it. The cards here draw a mid rank so the growth pieces are on show.
 * - **Two colours.** `color` is the body, `accent` is anything lit — cockpits, pods, sparks.
 *
 * Exposed as `window.EchoArenaArt`. `mount()` is the only part with no counterpart in the game: it
 * wraps a <canvas> in the sizing, the resize handling and the shared frame clock that every preview
 * on the page would otherwise repeat.
 */
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  /** The house outline. Every hull is drawn as ink-on-paper, so the edge is always the deep navy. */
  var OUTLINE = "#061530";

  /** The closed set of drawings, per shelf, in the order the backend lists them. */
  var ART = {
    ship: ["standard", "delta", "halo", "monarch", "prism", "seraph"],
    trail: ["ember", "ribbon", "bloom", "aurora", "shards", "nebula"],
    bolt: ["spark", "lance", "pulse", "blossom", "facet", "comet"],
  };

  /** What the base (everyone) items ship with — the palette a card borrows for the two parts it is
   *  not selling, so a hull card is not also advertising a wake it has nothing to do with. */
  var BASE_LOOK = {
    ship: { art: "standard", ink: "#ff624f", accent: "#f5dca4" },
    trail: { art: "ember", ink: "#ff5746", accent: "#f5dca4" },
    bolt: { art: "spark", ink: "#ff765c", accent: "#f5dca4" },
  };

  function clampRank(tier) {
    return Math.max(0, Math.min(8, Math.floor(tier)));
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Hulls                                                                                          */
  /* -------------------------------------------------------------------------------------------- */

  /** Scout Mk I — the hull the game has always shipped with. Grows a piece per upgrade card. */
  function drawStandard(context, rank, color, accent) {
    // Stabiliser ring, drawn under everything so it reads as field rather than structure.
    if (rank >= 5) {
      context.save();
      context.globalAlpha *= 0.42;
      context.strokeStyle = color;
      context.lineWidth = 1.3;
      context.setLineDash([4, 5]);
      context.beginPath();
      context.ellipse(0, 0, 25 + rank, 16 + rank * 0.7, 0, 0, TAU);
      context.stroke();
      context.restore();
    }

    // Wings: they appear with the first card and sweep wider with every one after it.
    if (rank >= 1) {
      var reach = 12 + rank * 1.7;
      context.save();
      context.globalAlpha *= 0.62;
      context.beginPath();
      context.moveTo(-2, 0);
      context.lineTo(-9 - rank, -reach);
      context.lineTo(-16 - rank * 0.9, -reach * 0.5);
      context.lineTo(-9, 0);
      context.lineTo(-16 - rank * 0.9, reach * 0.5);
      context.lineTo(-9 - rank, reach);
      context.closePath();
      context.fill();
      context.restore();
      context.stroke();
    }

    // Hull. The prow lengthens up to the sixth card, then holds.
    context.beginPath();
    context.moveTo(21 + Math.min(rank, 6) * 1.15, 0);
    context.lineTo(-13, -11);
    context.lineTo(-7, 0);
    context.lineTo(-13, 11);
    context.closePath();
    context.fill();
    context.stroke();

    // Dorsal fins.
    if (rank >= 4) {
      context.beginPath();
      context.moveTo(-4, -6);
      context.lineTo(-15, -9.5);
      context.lineTo(-11, -4.5);
      context.closePath();
      context.moveTo(-4, 6);
      context.lineTo(-15, 9.5);
      context.lineTo(-11, 4.5);
      context.closePath();
      context.fill();
      context.stroke();
    }

    // Engine pods, lit in the paper cream so the exhaust reads against any hull colour.
    if (rank >= 2) {
      context.fillStyle = accent;
      [-1, 1].forEach(function (side) {
        context.beginPath();
        context.ellipse(-12.5, side * 7.2, 3.3, 2.1, 0, 0, TAU);
        context.fill();
        context.stroke();
      });
    }

    context.fillStyle = accent;
    context.beginPath();
    context.arc(2, 0, 3.7 + Math.min(rank, 6) * 0.18, 0, TAU);
    context.fill();
    context.stroke();

    // Prow lance: the last piece, and the only one forward of the cockpit.
    if (rank >= 7) {
      context.beginPath();
      context.moveTo(12, -3.2);
      context.lineTo(27, 0);
      context.lineTo(12, 3.2);
      context.closePath();
      context.fillStyle = color;
      context.fill();
      context.stroke();
    }
  }

  /** Delta Lance — a narrow dart. Outriggers first, then canards, then the burner lengthens. */
  function drawDelta(context, rank, color, accent, time) {
    // Outriggers: two bars running the flanks, spreading with rank.
    if (rank >= 3) {
      context.save();
      context.globalAlpha *= 0.7;
      [-1, 1].forEach(function (side) {
        var out = 8 + rank * 0.55;
        context.beginPath();
        context.moveTo(-14, side * out);
        context.lineTo(11 + rank * 0.6, side * (out - 2.4));
        context.lineTo(15 + rank * 0.6, side * (out - 4.4));
        context.lineTo(-10, side * (out - 2.6));
        context.closePath();
        context.fill();
        context.stroke();
      });
      context.restore();
    }

    // Canards: forward-swept blades either side of the nose, from the first card.
    if (rank >= 1) {
      var reach = 7 + rank * 1.15;
      context.save();
      context.globalAlpha *= 0.78;
      [-1, 1].forEach(function (side) {
        context.beginPath();
        context.moveTo(5, side * 2.4);
        context.lineTo(16 + rank * 0.5, side * reach);
        context.lineTo(1, side * reach * 0.55);
        context.closePath();
        context.fill();
        context.stroke();
      });
      context.restore();
    }

    // Hull: long, thin, and pointed. The waist sits well aft of centre and the shoulders are narrow —
    // a wider mid-body plus the glow reads as a tube rather than as a dart at arena size.
    context.beginPath();
    context.moveTo(26 + Math.min(rank, 6) * 1.4, 0);
    context.lineTo(2, -3.4);
    context.lineTo(-9, -5.2);
    context.lineTo(-16, -3.6);
    context.lineTo(-19, 0);
    context.lineTo(-16, 3.6);
    context.lineTo(-9, 5.2);
    context.lineTo(2, 3.4);
    context.closePath();
    context.fill();
    context.stroke();

    // Spine: one lit line down the length, which is what sells the hull as narrow.
    context.save();
    context.globalAlpha *= 0.9;
    context.strokeStyle = accent;
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(-13, 0);
    context.lineTo(19 + Math.min(rank, 6), 0);
    context.stroke();
    context.restore();

    // Afterburner: a lit throat at the stern that breathes with the engine.
    if (rank >= 2) {
      var flare = 1 + Math.sin(time * 9) * 0.14;
      context.fillStyle = accent;
      context.beginPath();
      context.ellipse(-17.5, 0, 3.2, (3.4 + rank * 0.22) * flare, 0, 0, TAU);
      context.fill();
      context.stroke();
    }

    context.fillStyle = accent;
    context.beginPath();
    context.ellipse(4, 0, 4.6, 1.9, 0, 0, TAU);
    context.fill();
    context.stroke();

    if (rank >= 7) {
      context.beginPath();
      context.moveTo(16, -2.4);
      context.lineTo(31, 0);
      context.lineTo(16, 2.4);
      context.closePath();
      context.fillStyle = color;
      context.fill();
      context.stroke();
    }
  }

  /** Halo Core — a teardrop core inside a turning ring of nodes. The ring is the identity, so it is
   *  always there; rank adds nodes, widens it, and lights a dashed inner counter-ring. */
  function drawHalo(context, rank, color, accent, time) {
    var radius = 17 + rank * 0.9;
    var spin = time * 1.15;

    context.save();
    context.globalAlpha *= 0.85;
    context.strokeStyle = color;
    context.lineWidth = 2.3;
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.stroke();
    context.fillStyle = accent;
    var nodes = 3 + Math.min(rank, 5);
    for (var index = 0; index < nodes; index += 1) {
      var at = spin + (index / nodes) * TAU;
      context.beginPath();
      context.arc(Math.cos(at) * radius, Math.sin(at) * radius, 2.2, 0, TAU);
      context.fill();
    }
    context.restore();

    if (rank >= 4) {
      context.save();
      context.globalAlpha *= 0.5;
      context.strokeStyle = accent;
      context.lineWidth = 1.1;
      context.setLineDash([3, 4]);
      context.lineDashOffset = -spin * 6;
      context.beginPath();
      context.arc(0, 0, 11 + rank * 0.4, 0, TAU);
      context.stroke();
      context.restore();
    }

    // Core: a teardrop with the point forward.
    var nose = 14 + Math.min(rank, 6) * 0.95;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(nose, 0);
    context.quadraticCurveTo(2, -9, -10, -4.6);
    context.quadraticCurveTo(-13.5, 0, -10, 4.6);
    context.quadraticCurveTo(2, 9, nose, 0);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = accent;
    context.beginPath();
    context.arc(1, 0, 3.5 + Math.min(rank, 6) * 0.2, 0, TAU);
    context.fill();
    context.stroke();
  }

  /** Monarch — broad scalloped wings with printed eye-spots and a split streamer tail. */
  function drawMonarch(context, rank, color, accent, time) {
    var span = 13 + rank * 1.9;
    // The wings breathe rather than flap: a full flap cycle at arena speed reads as a stutter.
    var beat = 1 + Math.sin(time * 2.6) * 0.09;

    context.save();
    context.globalAlpha *= 0.88;
    [-1, 1].forEach(function (side) {
      context.beginPath();
      context.moveTo(2, side * 1.5);
      context.bezierCurveTo(
        6,
        side * span * 0.5 * beat,
        -6,
        side * span * beat,
        -14,
        side * span * 0.72 * beat,
      );
      context.bezierCurveTo(-10, side * span * 0.42, -17, side * span * 0.3, -12, side * 2.6);
      context.closePath();
      context.fill();
      context.stroke();
    });
    context.restore();

    // Eye-spots: one printed on each wing per card, up to three.
    var spots = Math.min(rank, 3);
    context.save();
    context.fillStyle = accent;
    context.globalAlpha *= 0.9;
    [-1, 1].forEach(function (side) {
      for (var index = 0; index < spots; index += 1) {
        context.beginPath();
        context.arc(-4 - index * 3.6, side * (span * 0.56 - index * 3.1) * beat, 1.9, 0, TAU);
        context.fill();
      }
    });
    context.restore();

    // Streamer tail.
    if (rank >= 3) {
      context.save();
      context.globalAlpha *= 0.8;
      [-1, 1].forEach(function (side) {
        context.beginPath();
        context.moveTo(-11, side * 1.6);
        context.lineTo(-22 - rank, side * (5 + rank * 0.5));
        context.lineTo(-13, side * 3.6);
        context.closePath();
        context.fill();
        context.stroke();
      });
      context.restore();
    }

    // Body: slim, so the wings carry the silhouette.
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(18 + Math.min(rank, 6) * 1.05, 0);
    context.lineTo(-4, -4.2);
    context.lineTo(-14, 0);
    context.lineTo(-4, 4.2);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = accent;
    context.beginPath();
    context.arc(3, 0, 3.2 + Math.min(rank, 6) * 0.18, 0, TAU);
    context.fill();
    context.stroke();

    if (rank >= 7) {
      context.save();
      context.globalAlpha *= 0.8;
      context.strokeStyle = accent;
      context.lineWidth = 1.2;
      [-1, 1].forEach(function (side) {
        context.beginPath();
        context.moveTo(10, side * 1.6);
        context.quadraticCurveTo(20, side * 3.4, 26 + rank, side * 9);
        context.stroke();
      });
      context.restore();
    }
  }

  /** Prism Drive — a faceted crystal with shards in orbit around a turning gem. */
  function drawPrism(context, rank, color, accent, time) {
    var turn = time * 1.6;
    var nose = 20 + Math.min(rank, 6) * 1.15;
    var index;
    var at;

    if (rank >= 6) {
      context.save();
      context.globalAlpha *= 0.38;
      context.strokeStyle = accent;
      context.lineWidth = 1.2;
      context.beginPath();
      for (index = 0; index <= 6; index += 1) {
        at = -turn * 0.4 + (index / 6) * TAU;
        var ringRadius = 22 + rank;
        var x = Math.cos(at) * ringRadius;
        var y = Math.sin(at) * ringRadius;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.stroke();
      context.restore();
    }

    // Refracted shards, held in orbit. One more per card, to five.
    if (rank >= 2) {
      var shards = Math.min(rank, 5);
      var radius = 16 + rank * 0.7;
      context.save();
      context.globalAlpha *= 0.72;
      context.fillStyle = accent;
      for (index = 0; index < shards; index += 1) {
        at = turn + (index / shards) * TAU;
        var sx = Math.cos(at) * radius;
        var sy = Math.sin(at) * radius;
        context.beginPath();
        context.moveTo(sx + Math.cos(at) * 3.8, sy + Math.sin(at) * 3.8);
        context.lineTo(sx - Math.sin(at) * 2.4, sy + Math.cos(at) * 2.4);
        context.lineTo(sx + Math.sin(at) * 2.4, sy - Math.cos(at) * 2.4);
        context.closePath();
        context.fill();
      }
      context.restore();
    }

    // Hull: a six-sided crystal.
    context.beginPath();
    context.moveTo(nose, 0);
    context.lineTo(6, -9.6);
    context.lineTo(-9, -8);
    context.lineTo(-15, 0);
    context.lineTo(-9, 8);
    context.lineTo(6, 9.6);
    context.closePath();
    context.fill();
    context.stroke();

    // Facet lines: what makes it read as cut rather than moulded.
    context.save();
    context.globalAlpha *= 0.5;
    context.strokeStyle = accent;
    context.lineWidth = 1.1;
    context.beginPath();
    context.moveTo(nose, 0);
    context.lineTo(-9, -8);
    context.moveTo(nose, 0);
    context.lineTo(-9, 8);
    context.moveTo(6, -9.6);
    context.lineTo(-15, 0);
    context.moveTo(6, 9.6);
    context.lineTo(-15, 0);
    context.stroke();
    context.restore();

    // The gem, turning inside the hull.
    context.save();
    context.translate(1, 0);
    context.rotate(turn);
    var gem = 4 + Math.min(rank, 6) * 0.22;
    context.fillStyle = accent;
    context.beginPath();
    context.moveTo(0, -gem);
    context.lineTo(gem, 0);
    context.lineTo(0, gem);
    context.lineTo(-gem, 0);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  /** Seraph — three pairs of light-feathers behind a spear body, under a broken halo. */
  function drawSeraph(context, rank, color, accent, time) {
    var breathe = 1 + Math.sin(time * 1.8) * 0.07;

    // The halo: two arcs, left open fore and aft so the hull reads through it.
    context.save();
    context.globalAlpha *= 0.55;
    context.strokeStyle = accent;
    context.lineWidth = 1.6;
    var haloX = 20 + rank * 0.8;
    var haloY = 13 + rank * 0.6;
    context.beginPath();
    context.ellipse(-2, 0, haloX, haloY, 0, -0.95, 0.95);
    context.stroke();
    context.beginPath();
    context.ellipse(-2, 0, haloX, haloY, 0, Math.PI - 0.95, Math.PI + 0.95);
    context.stroke();
    context.restore();

    // Feather pairs, opening out as the run goes deeper.
    var pairs = [
      { from: 0, length: 15, sweep: 0.55, alpha: 0.72 },
      { from: 2, length: 21, sweep: 0.9, alpha: 0.58 },
      { from: 5, length: 26, sweep: 1.25, alpha: 0.44 },
    ];
    pairs.forEach(function (pair) {
      if (rank < pair.from) return;
      var length = (pair.length + rank * 0.8) * breathe;
      context.save();
      context.globalAlpha *= pair.alpha;
      [-1, 1].forEach(function (side) {
        context.beginPath();
        context.moveTo(-3, side * 1.6);
        context.quadraticCurveTo(
          -6 - length * 0.35,
          side * length * 0.5,
          -8 - length * 0.7,
          side * length * pair.sweep * 0.6,
        );
        context.quadraticCurveTo(-2 - length * 0.3, side * length * 0.32, -4, side * 4);
        context.closePath();
        context.fill();
        context.stroke();
      });
      context.restore();
    });

    // Spear body.
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(23 + Math.min(rank, 6) * 1.2, 0);
    context.lineTo(-2, -5);
    context.lineTo(-14, 0);
    context.lineTo(-2, 5);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = accent;
    context.beginPath();
    context.arc(4, 0, 3.6 + Math.min(rank, 6) * 0.2, 0, TAU);
    context.fill();
    context.stroke();

    context.save();
    context.globalAlpha *= 0.5;
    context.strokeStyle = accent;
    context.lineWidth = 1;
    context.setLineDash([2, 3]);
    context.lineDashOffset = time * -8;
    context.beginPath();
    context.arc(4, 0, 7.6 + Math.min(rank, 6) * 0.3, 0, TAU);
    context.stroke();
    context.restore();
  }

  /**
   * Draw a hull in local space. The caller owns the transform, the alpha and the shadow; this owns
   * the fill, the outline and the geometry.
   */
  function drawHull(context, skin, tier, color, accent, time) {
    var rank = clampRank(tier);
    context.save();
    context.fillStyle = color;
    context.strokeStyle = OUTLINE;
    context.lineWidth = 2.2;
    context.lineJoin = "round";
    switch (skin) {
      case "delta":
        drawDelta(context, rank, color, accent, time);
        break;
      case "halo":
        drawHalo(context, rank, color, accent, time);
        break;
      case "monarch":
        drawMonarch(context, rank, color, accent, time);
        break;
      case "prism":
        drawPrism(context, rank, color, accent, time);
        break;
      case "seraph":
        drawSeraph(context, rank, color, accent, time);
        break;
      default:
        drawStandard(context, rank, color, accent);
    }
    context.restore();
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Wakes                                                                                          */
  /* -------------------------------------------------------------------------------------------- */

  /*
   * Every wake takes the same `points` buffer the game keeps: oldest first, newest last. So
   * `index / points.length` is "how new is this piece", which is what all six ramp their alpha and
   * their width on — the tail of the buffer is the tail of the wake.
   */

  /** Ember Wake — the tapered burn the game has always drawn. */
  function drawEmber(context, points, color, width) {
    for (var index = 1; index < points.length; index += 1) {
      var at = index / points.length;
      context.beginPath();
      context.moveTo(points[index - 1].x, points[index - 1].y);
      context.lineTo(points[index].x, points[index].y);
      context.strokeStyle = color;
      context.globalAlpha = at * 0.52;
      context.lineWidth = width * at;
      context.stroke();
    }
  }

  /** Silk Ribbon — two strands woven around the flight path in counter-phase, so they cross. */
  function drawRibbon(context, points, color, width, accent, time) {
    [0, Math.PI].forEach(function (phase, strand) {
      // The offset path: each point pushed along the normal of its own segment by a travelling sine.
      var woven = points.map(function (point, index) {
        var previous = points[Math.max(0, index - 1)];
        var dx = point.x - previous.x;
        var dy = point.y - previous.y;
        var length = Math.hypot(dx, dy) || 1;
        var at = index / points.length;
        var swing = Math.sin(index * 0.72 + time * 5.5 + phase) * width * 0.62 * at;
        return { x: point.x + (-dy / length) * swing, y: point.y + (dx / length) * swing };
      });
      for (var index = 1; index < woven.length; index += 1) {
        var at = index / woven.length;
        context.beginPath();
        context.moveTo(woven[index - 1].x, woven[index - 1].y);
        context.lineTo(woven[index].x, woven[index].y);
        context.strokeStyle = strand === 0 ? color : accent;
        context.globalAlpha = at * 0.5;
        context.lineWidth = Math.max(1, width * 0.3 * at + 0.6);
        context.stroke();
      }
    });
  }

  /** Star Bloom — four-point stars shed along the wake, turning as they fade. */
  function drawBloom(context, points, color, width, accent, time) {
    for (var index = 1; index < points.length; index += 2) {
      var at = index / points.length;
      var size = width * 0.5 * at + 1.3;
      context.save();
      context.translate(points[index].x, points[index].y);
      context.rotate(time * 2.2 + index * 0.6);
      context.globalAlpha = at * 0.75;
      context.fillStyle = index % 4 === 0 ? accent : color;
      context.beginPath();
      context.moveTo(0, -size);
      context.quadraticCurveTo(size * 0.22, -size * 0.22, size, 0);
      context.quadraticCurveTo(size * 0.22, size * 0.22, 0, size);
      context.quadraticCurveTo(-size * 0.22, size * 0.22, -size, 0);
      context.quadraticCurveTo(-size * 0.22, -size * 0.22, 0, -size);
      context.fill();
      context.restore();
    }
  }

  /** Aurora Veil — a wide band and a bright core, both shading from the accent at the tail to the
   *  body colour at the nose. One gradient for the whole wake, so the shift follows the flight path. */
  function drawAurora(context, points, color, width, accent, time) {
    var first = points[0];
    var last = points[points.length - 1];
    var veil = context.createLinearGradient(first.x, first.y, last.x, last.y);
    veil.addColorStop(0, accent);
    veil.addColorStop(1, color);
    context.strokeStyle = veil;

    [
      { scale: 1.75, alpha: 0.15 },
      { scale: 0.6, alpha: 0.48 },
    ].forEach(function (band) {
      for (var index = 1; index < points.length; index += 1) {
        var at = index / points.length;
        // The shimmer travels down the veil rather than pulsing it as a whole.
        var shimmer = 0.82 + Math.sin(index * 0.55 - time * 3.4) * 0.18;
        context.beginPath();
        context.moveTo(points[index - 1].x, points[index - 1].y);
        context.lineTo(points[index].x, points[index].y);
        context.globalAlpha = at * band.alpha * shimmer;
        context.lineWidth = width * band.scale * at + 0.5;
        context.stroke();
      }
    });
  }

  /** Prism Shards — chevrons stamped across the wake, opening wider toward the ship. */
  function drawShards(context, points, color, width, accent) {
    for (var index = 2; index < points.length; index += 2) {
      var at = index / points.length;
      var point = points[index];
      var behind = points[index - 2];
      var dx = point.x - behind.x;
      var dy = point.y - behind.y;
      var length = Math.hypot(dx, dy) || 1;
      var ux = dx / length;
      var uy = dy / length;
      var spread = width * 0.6 * at + 2;
      var sweep = spread * 0.85;
      context.beginPath();
      context.moveTo(point.x - uy * spread - ux * sweep, point.y + ux * spread - uy * sweep);
      context.lineTo(point.x, point.y);
      context.lineTo(point.x + uy * spread - ux * sweep, point.y - ux * spread - uy * sweep);
      context.strokeStyle = index % 4 === 0 ? accent : color;
      context.globalAlpha = at * 0.7;
      context.lineWidth = Math.max(1, width * 0.17);
      context.stroke();
    }
  }

  /** Nebula Bloom — glowing clouds pooling behind the hull. Additive, so overlaps burn brighter. */
  function drawNebula(context, points, color, width, accent, time) {
    context.globalCompositeOperation = "lighter";
    context.shadowColor = color;
    context.shadowBlur = 9;
    for (var index = 1; index < points.length; index += 1) {
      var at = index / points.length;
      var radius = width * 0.55 * at + 2 + Math.sin(index * 0.9 + time * 3) * 1.1;
      context.globalAlpha = at * 0.17;
      context.fillStyle = index % 3 === 0 ? accent : color;
      context.beginPath();
      context.arc(points[index].x, points[index].y, Math.max(0.5, radius), 0, TAU);
      context.fill();
    }
  }

  /**
   * Draw a wake through `points` (oldest first). `width` is the effect's full width at the ship;
   * every effect tapers from it back to nothing.
   */
  function drawWake(context, effect, points, color, width, accent, time) {
    if (points.length < 2) return;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    switch (effect) {
      case "ribbon":
        drawRibbon(context, points, color, width, accent, time);
        break;
      case "bloom":
        drawBloom(context, points, color, width, accent, time);
        break;
      case "aurora":
        drawAurora(context, points, color, width, accent, time);
        break;
      case "shards":
        drawShards(context, points, color, width, accent);
        break;
      case "nebula":
        drawNebula(context, points, color, width, accent, time);
        break;
      default:
        drawEmber(context, points, color, width);
    }
    context.restore();
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Bolts                                                                                          */
  /* -------------------------------------------------------------------------------------------- */

  /*
   * Every bolt is drawn in the round's own local space: the caller has translated to the head and
   * rotated to the direction of travel, so +X is forward and the burn trails back toward -X.
   *
   * `streak` is how far behind the head the burn reaches, `size` the head's radius. Both are handed
   * in because a round is drawn at several sizes across the game and these cards — and neither is
   * ever derived from damage, speed or the Prism tier: a bought round is a *look*, not a weapon.
   */

  /** Spark Round — the tapered burn the gun has always fired: one streak, one hot head. */
  function drawSparkBolt(context, streak, size, color, accent) {
    context.strokeStyle = color;
    context.lineWidth = size * 1.15;
    context.beginPath();
    context.moveTo(-streak, 0);
    context.lineTo(0, 0);
    context.stroke();

    context.fillStyle = accent;
    context.beginPath();
    context.arc(0, 0, size, 0, TAU);
    context.fill();
  }

  /** Lance Round — a needle with a lit tip and two barbs raked back along the shaft. */
  function drawLanceBolt(context, streak, size, color, accent) {
    // Barbs first, under the shaft, so the shaft reads as one unbroken line.
    context.save();
    context.globalAlpha *= 0.6;
    context.fillStyle = color;
    [-1, 1].forEach(function (side) {
      context.beginPath();
      context.moveTo(-streak * 0.28, side * size * 0.3);
      context.lineTo(-streak * 0.72, side * size * 1.5);
      context.lineTo(-streak * 0.6, side * size * 0.3);
      context.closePath();
      context.fill();
    });
    context.restore();

    context.fillStyle = color;
    context.beginPath();
    context.moveTo(size * 2.1, 0);
    context.lineTo(-streak * 0.9, -size * 0.48);
    context.lineTo(-streak * 1.08, 0);
    context.lineTo(-streak * 0.9, size * 0.48);
    context.closePath();
    context.fill();

    context.fillStyle = accent;
    context.beginPath();
    context.moveTo(size * 2.1, 0);
    context.lineTo(size * 0.1, -size * 0.62);
    context.lineTo(size * 0.1, size * 0.62);
    context.closePath();
    context.fill();
  }

  /**
   * Pulse Round — a bright core inside rings that beat outward as the round travels.
   *
   * The two rings are half a beat apart so there is always one mid-expansion: a single ring reads as
   * a flicker at the speed a round crosses the arena.
   */
  function drawPulseBolt(context, streak, size, color, accent, time) {
    context.strokeStyle = color;
    context.lineWidth = size * 0.9;
    context.beginPath();
    context.moveTo(-streak * 0.75, 0);
    context.lineTo(0, 0);
    context.stroke();

    var beat = (time * 5.5) % 1;
    [0, 0.5].forEach(function (offset) {
      var phase = (beat + offset) % 1;
      context.save();
      context.globalAlpha *= (1 - phase) * 0.6;
      context.strokeStyle = color;
      context.lineWidth = Math.max(0.6, size * 0.4);
      context.beginPath();
      context.arc(0, 0, size * (0.7 + phase * 2.4), 0, TAU);
      context.stroke();
      context.restore();
    });

    context.fillStyle = accent;
    context.beginPath();
    context.arc(0, 0, size * 0.92, 0, TAU);
    context.fill();
  }

  /** Blossom Round — a four-petal head that turns as it flies, shedding petals down the burn. */
  function drawBlossomBolt(context, streak, size, color, accent, time) {
    var petal = function (radius) {
      context.beginPath();
      context.moveTo(0, -radius);
      context.quadraticCurveTo(radius * 0.24, -radius * 0.24, radius, 0);
      context.quadraticCurveTo(radius * 0.24, radius * 0.24, 0, radius);
      context.quadraticCurveTo(-radius * 0.24, radius * 0.24, -radius, 0);
      context.quadraticCurveTo(-radius * 0.24, -radius * 0.24, 0, -radius);
      context.fill();
    };

    // Shed petals: older, smaller and fainter the further back down the burn they sit.
    for (var index = 1; index <= 3; index += 1) {
      var at = index / 4;
      context.save();
      context.translate(-streak * at, 0);
      context.rotate(time * 3.4 - index * 0.9);
      context.globalAlpha *= (1 - at) * 0.85;
      context.fillStyle = color;
      petal(size * (1 - at * 0.55));
      context.restore();
    }

    context.save();
    context.rotate(time * 3.4);
    context.fillStyle = accent;
    petal(size * 1.35);
    context.restore();
  }

  /** Facet Round — a cut chevron head with two split ghosts of itself refracted off to either side. */
  function drawFacetBolt(context, streak, size, color, accent, time) {
    var chevron = function (scale) {
      context.beginPath();
      context.moveTo(size * 1.7 * scale, 0);
      context.lineTo(-size * 0.9 * scale, -size * 1.15 * scale);
      context.lineTo(-size * 0.15 * scale, 0);
      context.lineTo(-size * 0.9 * scale, size * 1.15 * scale);
      context.closePath();
      context.fill();
    };

    // The ghosts drift apart and back together, which is what sells them as a refraction rather than
    // as three separate rounds the player has to track.
    var split = (0.55 + Math.sin(time * 4.2) * 0.45) * size * 1.5;
    [-1, 1].forEach(function (side) {
      context.save();
      context.translate(-streak * 0.45, side * split);
      context.globalAlpha *= 0.42;
      context.fillStyle = color;
      chevron(0.8);
      context.restore();
    });

    context.save();
    context.globalAlpha *= 0.5;
    context.strokeStyle = color;
    context.lineWidth = Math.max(0.5, size * 0.3);
    context.beginPath();
    context.moveTo(-streak, 0);
    context.lineTo(-size, 0);
    context.stroke();
    context.restore();

    context.fillStyle = accent;
    chevron(1);
  }

  /** Comet Round — a burning head dragging a plume that pools and cools behind it. Additive, so the
   *  overlap down the middle of the plume burns brightest. */
  function drawCometBolt(context, streak, size, color, accent, time) {
    context.globalCompositeOperation = "lighter";
    context.shadowColor = color;
    context.shadowBlur = size * 3;
    for (var index = 6; index >= 1; index -= 1) {
      var at = index / 6;
      context.save();
      context.globalAlpha *= (1 - at) * 0.5 + 0.12;
      context.fillStyle = color;
      context.beginPath();
      context.arc(
        -streak * at,
        Math.sin(time * 7 - index * 0.8) * size * 0.4 * at,
        Math.max(0.4, size * (1.15 - at * 0.75)),
        0,
        TAU,
      );
      context.fill();
      context.restore();
    }

    context.fillStyle = accent;
    context.beginPath();
    context.arc(0, 0, size * 1.05, 0, TAU);
    context.fill();
  }

  /**
   * Draw one round in local space. The caller owns the transform, the alpha and the shadow; this
   * owns the fill and the geometry.
   */
  function drawBolt(context, bolt, streak, size, color, accent, time) {
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    switch (bolt) {
      case "lance":
        drawLanceBolt(context, streak, size, color, accent);
        break;
      case "pulse":
        drawPulseBolt(context, streak, size, color, accent, time);
        break;
      case "blossom":
        drawBlossomBolt(context, streak, size, color, accent, time);
        break;
      case "facet":
        drawFacetBolt(context, streak, size, color, accent, time);
        break;
      case "comet":
        drawCometBolt(context, streak, size, color, accent, time);
        break;
      default:
        drawSparkBolt(context, streak, size, color, accent);
    }
    context.restore();
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Previews                                                                                       */
  /* -------------------------------------------------------------------------------------------- */

  /** How many samples of the flight path a preview wake is drawn through. The arena keeps 23. */
  var PREVIEW_TRAIL = 26;
  /**
   * Radians of the flight path between samples — far coarser than the arena's own spacing. A card is
   * a couple of hundred pixels wide, and a wake scaled honestly to that box is a stub barely longer
   * than the hull, at which point a ribbon, a veil and a scatter of stars are the same small smudge.
   */
  var PREVIEW_STEP = 0.105;

  /** Rounds a preview keeps in the air: enough to read the spacing of a burst, few enough that they
   *  do not become a second wake. */
  var PREVIEW_ROUNDS = 4;
  /** Radians of flight path between the oldest round in the air and the ship. Each round is fired
   *  from where the ship *was*, so a ship that is always turning lays a fan rather than a line. */
  var PREVIEW_FIRE_SPAN = 0.3;
  /** How fast a round outruns the ship, in card widths per radian of flight path. */
  var PREVIEW_ROUND_SPEED = 1.35;

  /**
   * One frame of a preview: a ship flying a figure-eight inside the box, wake and rounds and all.
   *
   * The path is a Lissajous curve because it turns constantly and never repeats a heading for long,
   * which is what makes a wake worth looking at — a ship crossing in a straight line shows nothing
   * that distinguishes a ribbon from a veil.
   */
  function drawPreview(context, width, height, time, options) {
    context.clearRect(0, 0, width, height);

    var centreX = width / 2;
    var centreY = height / 2;
    // A bolt card flies a tighter figure-eight: the rounds leave on the tangent and keep going, so
    // the ship has to give up some of the box to have anywhere to shoot into.
    var reach = options.emphasis === "bolt" ? 0.62 : 1;
    var radiusX = width * 0.33 * reach;
    var radiusY = height * 0.27 * reach;
    var at = function (phase) {
      return {
        x: centreX + Math.cos(phase) * radiusX,
        y: centreY + Math.sin(phase * 2) * radiusY,
      };
    };

    var head = time * 0.85;
    var points = [];
    for (var step = PREVIEW_TRAIL; step >= 0; step -= 1) points.push(at(head - step * PREVIEW_STEP));

    var nose = at(head + 0.02);
    var ship = points[points.length - 1];
    var angle = Math.atan2(nose.y - ship.y, nose.x - ship.x);

    var loud = options.emphasis === "wake";
    context.save();
    context.shadowColor = options.wakeColor;
    context.shadowBlur = 8;
    drawWake(
      context,
      options.effect,
      loud ? points : points.slice(-11),
      options.wakeColor,
      // A touch wider than the arena's 12, for the same reason the path is stretched: the width is
      // what separates a veil from a ribbon, and it is the first thing lost at card size.
      (loud ? 15 : 10) * options.scale,
      options.wakeAccent,
      time,
    );
    context.restore();

    // Rounds in the air, each fired from a point the ship has already flown through. Drawn before
    // the hull so a round leaving the nose passes under it rather than over the cockpit.
    var selling = options.emphasis === "bolt";
    var boltScale = options.scale * (selling ? 1.9 : 1.05);
    var drift = (time * 0.9) % 1;
    for (var index = 0; index < (selling ? PREVIEW_ROUNDS : 2); index += 1) {
      var age = ((index + drift) / PREVIEW_ROUNDS) * PREVIEW_FIRE_SPAN;
      var from = at(head - age);
      var ahead = at(head - age + 0.02);
      var heading = Math.atan2(ahead.y - from.y, ahead.x - from.x);
      // The muzzle offset is the arena's own: rounds leave 17 units ahead of the ship's centre.
      var travel = 17 * options.scale + age * PREVIEW_ROUND_SPEED * width;
      context.save();
      context.globalAlpha = (selling ? 1 : 0.5) * (1 - (age / PREVIEW_FIRE_SPAN) * 0.55);
      context.translate(from.x + Math.cos(heading) * travel, from.y + Math.sin(heading) * travel);
      context.rotate(heading);
      context.shadowColor = options.boltColor;
      context.shadowBlur = 8;
      drawBolt(
        context,
        options.bolt,
        13 * boltScale,
        2.7 * boltScale,
        options.boltColor,
        options.boltAccent,
        time,
      );
      context.restore();
    }

    context.save();
    context.translate(ship.x, ship.y);
    context.rotate(angle);
    context.scale(options.scale, options.scale);
    context.shadowColor = options.hullColor;
    context.shadowBlur = 12;
    drawHull(context, options.skin, options.rank, options.hullColor, options.hullAccent, time);
    context.restore();
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Preview clock                                                                                  */
  /* -------------------------------------------------------------------------------------------- */

  var subscribers = new Set();
  var frameHandle = 0;

  /**
   * One `requestAnimationFrame` loop shared by every preview on screen.
   *
   * The catalogue shows a dozen cards at once. A rAF per card is a dozen loops competing for the same
   * frame, and they drift out of phase, so twelve ships flying the same path visibly disagree about
   * where they are. One clock keeps them in step and costs one callback. It stops itself when the
   * last subscriber leaves, so a closed dialog is not still animating behind the page.
   */
  function onPreviewFrame(frame) {
    subscribers.add(frame);
    if (frameHandle === 0) {
      var tick = function (now) {
        var seconds = now / 1000;
        subscribers.forEach(function (subscriber) {
          subscriber(seconds);
        });
        frameHandle = window.requestAnimationFrame(tick);
      };
      frameHandle = window.requestAnimationFrame(tick);
    }
    return function () {
      subscribers.delete(frame);
      if (subscribers.size === 0 && frameHandle !== 0) {
        window.cancelAnimationFrame(frameHandle);
        frameHandle = 0;
      }
    };
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Mounting                                                                                       */
  /* -------------------------------------------------------------------------------------------- */

  /** The rank the cards draw at: far enough in that the growth pieces most hulls only get at rank
   *  4–5 are visible, short of the rank-7 prow so the base silhouette still reads. */
  var CARD_RANK = 5;

  function emphasisFor(kind) {
    if (kind === "ship") return "hull";
    if (kind === "bolt") return "bolt";
    return "wake";
  }

  /**
   * Turn one item — a catalogue row, or the half-filled state of the edit form — into the full set
   * of `drawPreview` options.
   *
   * Every preview draws a *whole ship*, because that is the thing an operator is judging: a wake with
   * no hull in front of it is an abstract squiggle, and a round drawn on its own is three pixels.
   *
   * **Shape identifies the item; colour identifies the card.** The two shelves the item is not on
   * lend their *drawing* — the base hull for a wake, the base wake for a hull — but not their
   * palette: the whole card is painted in the item's own two colours, over its own gradient. The
   * game does it the other way round, because there each part is the pilot's real equipped one. Here
   * they are stand-ins, and a stand-in in a *different* colour reads as a second item that came with
   * the first, which is exactly the thing an operator must not believe about this page.
   */
  function optionsFor(item) {
    var kind = ART[item.kind] ? item.kind : "ship";
    var art = ART[kind].indexOf(item.art) >= 0 ? item.art : ART[kind][0];
    var ink = item.ink || BASE_LOOK[kind].ink;
    var accent = item.accent || BASE_LOOK[kind].accent;
    var shape = {
      ship: BASE_LOOK.ship.art,
      trail: BASE_LOOK.trail.art,
      bolt: BASE_LOOK.bolt.art,
    };
    shape[kind] = art;
    return {
      skin: shape.ship,
      effect: shape.trail,
      bolt: shape.bolt,
      hullColor: ink,
      hullAccent: accent,
      wakeColor: ink,
      wakeAccent: accent,
      boltColor: ink,
      boltAccent: accent,
      rank: typeof item.rank === "number" ? item.rank : CARD_RANK,
      emphasis: emphasisFor(kind),
    };
  }

  /**
   * Drive a <canvas> from a callback that returns the item to draw.
   *
   * Returns `{ update, destroy }`: `update()` repaints a still preview after the form changes, and
   * `destroy()` releases the frame subscription and the resize observer. Callers that rebuild their
   * markup (the shelf does, on every load) must call `destroy()` on the old handles or the clock
   * keeps painting canvases that have left the document.
   */
  function mount(canvas, getItem) {
    var width = 0;
    var height = 0;

    function measure() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var nextWidth = Math.max(1, Math.round(rect.width));
      var nextHeight = Math.max(1, Math.round(rect.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      // Assigning either dimension resets the bitmap *and* the transform even when the value is
      // unchanged, so this is guarded above rather than run on every observer callback — which would
      // wipe the frame the loop had just painted.
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      var context = canvas.getContext("2d");
      if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function paint(time) {
      measure();
      var context = canvas.getContext("2d");
      if (!context || width === 0) return;
      var item = getItem();
      if (!item) return;
      var options = optionsFor(item);
      // The hulls are drawn at arena scale (~45 world units nose to tail); a card is much smaller.
      options.scale = Math.max(0.34, Math.min(0.85, height / 118));
      drawPreview(context, width, height, time, options);
    }

    measure();

    var observer = null;
    if (typeof window.ResizeObserver !== "undefined") {
      observer = new window.ResizeObserver(function () {
        measure();
      });
      observer.observe(canvas);
    }

    // An operator who has asked for less motion gets the ship parked mid-turn rather than flying:
    // the shape and the wake are the information, and both are legible standing still.
    var still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;

    var stop = null;
    if (still) paint(1.15);
    else stop = onPreviewFrame(paint);

    return {
      update: function () {
        if (still) paint(1.15);
      },
      destroy: function () {
        if (stop) stop();
        if (observer) observer.disconnect();
      },
    };
  }

  window.EchoArenaArt = {
    art: ART,
    baseLook: BASE_LOOK,
    cardRank: CARD_RANK,
    drawHull: drawHull,
    drawWake: drawWake,
    drawBolt: drawBolt,
    drawPreview: drawPreview,
    onPreviewFrame: onPreviewFrame,
    optionsFor: optionsFor,
    mount: mount,
  };
})();
