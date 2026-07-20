/* ============================================================
   ClipForge — mock data + interaction wiring (no backend)
   ============================================================ */
(function () {
  "use strict";

  // ---- helpers -------------------------------------------------
  var TOTAL = 4 * 3600 + 1 * 60 + 22; // 4:01:22 in seconds

  function fmtHMS(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return (h > 0 ? h + ":" : "0:") + pad(m) + ":" + pad(s);
  }
  function fmtClock(sec) {
    // always HH:MM:SS
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(m) + ":" + pad(s);
  }

  // Deterministic PRNG (mulberry32)
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- library tree data --------------------------------------
  var TREE = [
    {
      key: "live", label: "LIVE", collapsed: false,
      items: [
        { id: "l1", name: "ranked_grind_day47.mp4", dur: "3:12:44", live: true, note: "recording" }
      ]
    },
    {
      key: "processed", label: "PROCESSED", collapsed: false,
      items: [
        { id: "p1", name: "subathon_finale.mp4", dur: "4:01:22", active: true },
        { id: "p2", name: "valorant_scrims_0712.mp4", dur: "2:47:10" },
        { id: "p3", name: "just_chatting_0711.mp4", dur: "1:58:33" },
        { id: "p4", name: "speedrun_pb_attempts.mp4", dur: "3:22:07" }
      ]
    },
    {
      key: "archived", label: "ARCHIVED", collapsed: true,
      items: [
        { id: "a1", name: "charity_marathon_0628.mp4", dur: "6:14:59" },
        { id: "a2", name: "react_watchparty_0620.mp4", dur: "2:05:41" },
        { id: "a3", name: "old_ranked_climb.mp4", dur: "4:48:12" },
        { id: "a4", name: "irl_walk_downtown_0605.mp4", dur: "1:37:28" }
      ]
    }
  ];

  var ICONS = {
    live: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/><path d="M4.5 4.5a5 5 0 000 7M11.5 4.5a5 5 0 010 7" stroke-linecap="round"/></svg>',
    processed: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M2.5 6h11M5.5 3.5v9M10.5 3.5v9"/></svg>',
    archived: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="4.5" width="11" height="8" rx="1"/><path d="M2.5 4.5l1.5-2h8l1.5 2M6 8h4"/></svg>',
    remote: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.5 9.5l3-3M7.6 4.6l.9-.9a2.3 2.3 0 013.2 3.2l-.9.9M8.4 11.4l-.9.9a2.3 2.3 0 01-3.2-3.2l.9-.9" stroke-linecap="round"/></svg>'
  };

  // ---- clip candidate data ------------------------------------
  // times in seconds
  var CLIPS = [
    { id: "c1", start: 812, end: 851, score: 6.4, state: "none",
      excerpt: "wait wait wait is that actually going to work—",
      transcript: "okay so the plan here is kind of insane but stay with me. if this lines up right we are looking at a wait wait wait is that actually going to work— oh my god it's working. it's actually happening right now.",
      trigger: "wait wait wait is that actually going to work" },
    { id: "c2", start: 3025, end: 3052, score: 8.7, state: "selected",
      excerpt: "NO WAY he actually hit that shot from across the—",
      transcript: "he's got no ammo, one shot left, everyone's calling it. and then— NO WAY he actually hit that shot from across the map. that is the single cleanest flick I have seen all season, chat lost their minds.",
      trigger: "NO WAY he actually hit that shot from across the" },
    { id: "c3", start: 5340, end: 5379, score: 9.4, state: "approved",
      excerpt: "chat is going absolutely insane right now",
      transcript: "I don't even know what to say. that combo shouldn't be possible on this patch. chat is going absolutely insane right now, look at this spam, we broke the emote counter again.",
      trigger: "chat is going absolutely insane right now" },
    { id: "c4", start: 7180, end: 7213, score: 5.2, state: "discarded",
      excerpt: "okay that was genuinely the worst luck I've ever…",
      transcript: "how. HOW does that happen. okay that was genuinely the worst luck I've ever had on stream, I'm not even mad anymore I'm just impressed at how bad that was.",
      trigger: "okay that was genuinely the worst luck I've ever" },
    { id: "c5", start: 8890, end: 8931, score: 7.8, state: "approved",
      excerpt: "we are SO back, I cannot believe that read",
      transcript: "he baited the whole team into the choke and then just— we are SO back, I cannot believe that read. that is why you never count us out, momentum is completely flipped now.",
      trigger: "we are SO back, I cannot believe that read" },
    { id: "c6", start: 10420, end: 10447, score: 6.9, state: "none",
      excerpt: "hold on, did the game just crash on the final—",
      transcript: "we're one round away, everything is on the line, and— hold on, did the game just crash on the final round? you have got to be kidding me. mods can we get an F in chat.",
      trigger: "hold on, did the game just crash on the final" },
    { id: "c7", start: 12655, end: 12699, score: 8.1, state: "none",
      excerpt: "that donation just paid off the whole sub goal",
      transcript: "wait what— that donation just paid off the whole sub goal in one go. I'm actually speechless. thank you so much, that is unreal, we hit the goal on day one of the subathon.",
      trigger: "that donation just paid off the whole sub goal" },
    { id: "c8", start: 13980, end: 14019, score: 7.3, state: "none",
      excerpt: "alright chat, one more game and then we call it",
      transcript: "okay my hands are officially done for the night. alright chat, one more game and then we call it, for real this time, no take-backs. let's make this last one count.",
      trigger: "alright chat, one more game and then we call it" }
  ];

  // remember original bounds for trim clamping (±5min) and the trim window
  CLIPS.forEach(function (c) { c.origStart = c.start; c.origEnd = c.end; });

  var CAPTION_ON = true;
  var CAPTION_STYLE = "bold-outline"; // shared with the Settings select
  var CAPTION_STYLES = ["bold-outline", "clean", "karaoke"];

  // ---- export state -------------------------------------------
  // Rows are derived from approved clips; the two pre-approved clips keep
  // their mock statuses, anything newly approved shows up as "pending".
  var EXPORT_STATUS = {
    c3: { status: "done" },
    c5: { status: "exporting", pct: 47 }
  };
  var EXPORT_PLATFORMS = ["shorts", "tiktok", "instagram"];

  // ---- processing queue data ----------------------------------
  var QUEUE = [
    { name: "ranked_grind_day47.mp4", stage: "INGESTING", pct: 34 },
    { name: "morning_scrims_0716.mp4", stage: "TRANSCRIBING", pct: 61 },
    { name: "just_chatting_0711.mp4", stage: "COMPLETE", pct: 100 }
  ];

  var PLATFORM_GLYPH = {
    shorts: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4" y="2" width="8" height="12" rx="2"/><path d="M7 6.2v3.6l3-1.8z" fill="currentColor" stroke="none"/></svg>',
    tiktok: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 2.5v7.2a2.6 2.6 0 11-2-2.53" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 2.5c.3 1.6 1.4 2.6 3 2.8" stroke-linecap="round"/></svg>',
    instagram: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/><circle cx="8" cy="8" r="2.6"/><circle cx="11" cy="5" r="0.6" fill="currentColor" stroke="none"/></svg>',
    youtube: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="4" width="12" height="8.5" rx="2"/><path d="M7 6.5v3.5l3-1.75z" fill="currentColor" stroke="none"/></svg>',
    twitch: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 2.5h9.5v6.8l-3 3H8l-2 2v-2H3.5V4z" stroke-linejoin="round"/><path d="M8 5.5v2.8M11 5.5v2.8" stroke-linecap="round"/></svg>'
  };

  // ============================================================
  //  Timeline mock dataset (deterministic)
  // ============================================================
  var NBARS = 140;
  var baseline = [];  // 0..1 highlight score per bar
  (function buildBaseline() {
    var rnd = mulberry32(42);
    // smooth-ish noise via random walk + soft clamp
    var v = 0.3;
    for (var i = 0; i < NBARS; i++) {
      v += (rnd() - 0.5) * 0.22;
      // gentle pull toward mid
      v += (0.35 - v) * 0.05;
      if (v < 0.04) v = 0.04 + rnd() * 0.05;
      if (v > 0.95) v = 0.95 - rnd() * 0.05;
      baseline.push(v);
    }
  })();

  // coral spikes clustered near clip candidate x positions
  var spikes = []; // {idx, val}
  (function buildSpikes() {
    var rnd = mulberry32(1337);
    CLIPS.forEach(function (c, ci) {
      var center = Math.round((c.start / TOTAL) * (NBARS - 1));
      var count = 1 + Math.floor(rnd() * 2); // 1-2 per cluster
      for (var k = 0; k < count; k++) {
        var off = Math.round((rnd() - 0.5) * 4);
        var idx = Math.min(NBARS - 1, Math.max(0, center + off));
        spikes.push({ idx: idx, val: 0.55 + rnd() * 0.45 });
      }
      // bump baseline around strong clips too
      if (c.score >= 8) baseline[center] = Math.min(1, baseline[center] + 0.3);
    });
    // a couple standalone ambient spikes
    [18, 63, 101].forEach(function (i) { spikes.push({ idx: i, val: 0.5 + rnd() * 0.3 }); });
  })();

  // ============================================================
  //  State
  // ============================================================
  var state = {
    selectedClipId: "c2",
    sidebarActiveId: "p1",
    playhead: 0.34 // fraction of TOTAL
  };

  // signal source of the active (real) video; null in mock mode. Surfaced as
  // an extra "Signal" stat row in the Details panel.
  var activeSignal = null;

  // ============================================================
  //  Render: sidebar tree
  // ============================================================
  var fileTree = document.getElementById("fileTree");

  function renderTree() {
    var html = "";
    TREE.forEach(function (group) {
      html += '<div class="tree-group' + (group.collapsed ? " collapsed" : "") + '" data-group="' + group.key + '">';
      html += '<div class="tree-group-head">';
      html += '<span class="g-label"><span class="g-caret"><svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2.5 1.5l4 3.5-4 3.5z"/></svg></span>' + group.label + '</span>';
      html += '<span class="g-count mono">' + group.items.length + '</span>';
      html += '</div>';
      html += '<div class="tree-items">';
      group.items.forEach(function (it) {
        var active = it.id === state.sidebarActiveId;
        html += '<div class="tree-row' + (active ? " active" : "") + '" data-id="' + it.id + '">';
        if (it.live) {
          html += '<span class="live-dot" title="recording"></span>';
        } else if (it.remote) {
          html += '<span class="t-icon">' + ICONS.remote + '</span>';
        } else {
          html += '<span class="t-icon">' + ICONS[group.key] + '</span>';
        }
        html += '<span class="t-name">' + escapeHtml(it.name) + '</span>';
        // remote rows show "remote" only until real metadata (duration) arrives
        html += '<span class="t-dur">' + ((it.remote && !it.dur) ? "remote" : it.dur) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    });
    fileTree.innerHTML = html;

    // group collapse
    fileTree.querySelectorAll(".tree-group-head").forEach(function (head) {
      head.addEventListener("click", function () {
        head.parentElement.classList.toggle("collapsed");
      });
    });
    // row select
    fileTree.querySelectorAll(".tree-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var id = row.getAttribute("data-id");
        state.sidebarActiveId = id;
        renderTree();
        onSidebarSelect(id);
      });
    });
  }

  // ============================================================
  //  Render: clip candidates list
  // ============================================================
  var clipList = document.getElementById("clipList");
  var clipCount = document.getElementById("clipCount");

  function updateCounts() {
    var approved = CLIPS.filter(function (c) { return c.state === "approved"; }).length;
    clipCount.innerHTML = CLIPS.length + " candidates &middot; " + approved + " approved";
  }

  var CHECK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 7.5l3 3 6-6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHECK_FILLED = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="6.5" opacity="0.18"/><path d="M4 7.2l2.2 2.2L10 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var XMARK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke-linecap="round"/></svg>';

  function renderClips() {
    var html = "";
    CLIPS.forEach(function (c) {
      var isSel = c.id === state.selectedClipId;
      var cls = "clip-row";
      if (isSel) cls += " active";
      if (c.state === "discarded") cls += " discarded";
      html += '<div class="' + cls + '" data-id="' + c.id + '">';
      html += '<span class="c-range">' + fmtClock(c.start) + "–" + fmtClock(c.end) + '</span>';
      html += '<span class="score-badge' + (c.score >= 8 ? " high" : "") + '">' + c.score.toFixed(1) + '</span>';
      if (c.excerpt) {
        html += '<span class="c-excerpt">' + escapeHtml(c.excerpt) + '</span>';
      } else {
        // signal-appropriate muted fallback (reason reads well here)
        html += '<span class="c-excerpt muted">' + escapeHtml(c.reason || "detected segment") + '</span>';
      }
      html += '<span class="c-actions">';
      if (c.state === "approved") html += '<span class="approved-tag">APPROVED</span>';
      html += '<button class="ghost-btn approve' + (c.state === "approved" ? " on-approve" : "") + '" data-act="approve" title="Approve">' + (c.state === "approved" ? CHECK_FILLED : CHECK) + '</button>';
      html += '<button class="ghost-btn discard" data-act="discard" title="Discard">' + XMARK + '</button>';
      html += '</span>';
      html += '</div>';
    });
    clipList.innerHTML = html;

    clipList.querySelectorAll(".clip-row").forEach(function (row) {
      var id = row.getAttribute("data-id");
      row.addEventListener("click", function (e) {
        if (e.target.closest(".ghost-btn")) return;
        selectClip(id);
      });
      row.querySelectorAll(".ghost-btn").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var act = btn.getAttribute("data-act");
          toggleClipState(id, act);
        });
      });
    });
    updateCounts();
  }

  function toggleClipState(id, act) {
    var c = findClip(id);
    if (!c) return;
    if (act === "approve") {
      c.state = (c.state === "approved") ? "none" : "approved";
    } else {
      c.state = (c.state === "discarded") ? "none" : "discarded";
    }
    renderClips();
    // if the currently selected clip got discarded, refresh details (empty state)
    if (id === state.selectedClipId) renderDetails();
    drawTimeline();
    renderExport(); // approved list drives the Export tab
  }

  function selectClip(id) {
    state.selectedClipId = id;
    renderClips();
    renderDetails();
    drawTimeline();
  }

  // ============================================================
  //  Render: right panel — Details
  // ============================================================
  var detailsView = document.getElementById("detailsView");

  function renderDetails() {
    var c = findClip(state.selectedClipId);
    if (!c || c.state === "discarded") {
      detailsView.innerHTML =
        '<div class="empty-state">' +
        '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="7" y="10" width="26" height="20" rx="2"/><path d="M7 16h26M14 10v20M26 10v20"/></svg>' +
        '<span>Select a clip to see details</span>' +
        '</div>';
      return;
    }

    var dur = c.end - c.start;
    var reason = c.reason || (c.score >= 8 ? "chat spike 4.1×" : "audio spike 2.3×");

    // transcript with trigger highlighted — or a muted M2 placeholder when empty
    var transcriptHtml;
    if (c.transcript) {
      var tHtml = escapeHtml(c.transcript);
      if (c.trigger) {
        var trig = escapeHtml(c.trigger);
        tHtml = tHtml.replace(trig, '<mark>' + trig + '</mark>');
      }
      transcriptHtml = '<div class="transcript-box">' + tHtml + '</div>';
    } else if (c.transcribed) {
      transcriptHtml = '<div class="transcript-box pending">no speech detected in window</div>';
    } else {
      transcriptHtml = '<div class="transcript-box pending">transcript pending (M2)</div>';
    }

    var html = '<div class="insp-scroll">';

    // thumbnail (+ live caption preview when captions are on)
    html += '<div class="clip-thumb">' +
      '<span class="th-play"><svg width="34" height="34" viewBox="0 0 34 34" fill="none"><circle cx="17" cy="17" r="16" stroke="rgba(255,255,255,0.2)"/><path d="M14 11l10 6-10 6z" fill="rgba(255,255,255,0.8)"/></svg></span>' +
      '<span class="th-time">' + fmtClock(c.start) + '</span>' +
      (CAPTION_ON ? captionOverlayHTML(c) : '') +
      '</div>';

    // stats
    html += '<div class="stat-list">';
    html += statRow("Range", fmtClock(c.start) + " – " + fmtClock(c.end), null, "statRangeVal");
    html += statRow("Duration", fmtDur(dur), null, "statDurVal");
    html += statRow("Score", c.score.toFixed(1) + " / 10");
    html += statRow("Reason", reason, "teal");
    html += statRow("Model", "clipforge-det-v2", "muted");
    var sigVal = (c.signals && c.signals.length) ? c.signals.join(" + ")
      : (c.signal || activeSignal);
    if (sigVal) html += statRow("Signal", sigVal, "muted");
    html += '</div>';

    // transcript
    html += '<div class="insp-section"><span class="label">Transcript</span>' +
      transcriptHtml + '</div>';

    // trim
    html += '<div class="insp-section"><span class="label">Trim</span>' +
      '<div class="trim-inputs">' +
      '<div class="trim-field"><span class="label">Start</span><input type="text" id="trimStart" value="' + fmtClock(c.start) + '" spellcheck="false"></div>' +
      '<div class="trim-field"><span class="label">End</span><input type="text" id="trimEnd" value="' + fmtClock(c.end) + '" spellcheck="false"></div>' +
      '</div>' +
      '<div class="trim-bar" id="trimBar"><span class="tb-range"></span><span class="tb-handle left"></span><span class="tb-handle right"></span></div>' +
      '</div>';

    // caption toggle + style picker
    html += '<div class="insp-section"><div class="caption-row">' +
      '<span class="label">Caption Style</span>' +
      '<div class="toggle' + (CAPTION_ON ? " on" : "") + '" id="captionToggle"><span class="knob"></span></div>' +
      '<div class="seg" id="capSeg">' +
      CAPTION_STYLES.map(function (s) {
        return '<button data-style="' + s + '"' + (s === CAPTION_STYLE ? ' class="active"' : '') + '>' + s + '</button>';
      }).join('') +
      '</div>' +
      '</div></div>';

    html += '</div>'; // insp-scroll

    // action row (pinned)
    html += '<div class="action-row">' +
      '<button class="btn primary" data-act="approve">Approve</button>' +
      '<button class="btn discard" data-act="discard">Discard</button>' +
      '<button class="btn" data-act="rescore">Re-score</button>' +
      '</div>';

    detailsView.innerHTML = html;

    // wire caption toggle + style picker
    var tog = document.getElementById("captionToggle");
    if (tog) tog.addEventListener("click", function () {
      CAPTION_ON = !CAPTION_ON;
      renderDetails(); // re-render so the thumbnail overlay follows
    });
    var seg = document.getElementById("capSeg");
    if (seg) seg.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setCaptionStyle(btn.getAttribute("data-style"));
      });
    });

    // wire action buttons
    detailsView.querySelectorAll(".action-row .btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-act");
        if (act === "approve") toggleClipState(c.id, "approve");
        else if (act === "discard") toggleClipState(c.id, "discard");
        else if (act === "rescore") rescoreClip(c.id, btn);
      });
    });

    wireTrim(c);
  }

  // ---- trim editing -------------------------------------------
  function parseHMS(s) {
    var m = String(s).trim().match(/^(\d{1,2}):([0-5]?\d):([0-5]?\d)$/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }

  function wireTrim(c) {
    var startIn = document.getElementById("trimStart");
    var endIn = document.getElementById("trimEnd");
    var bar = document.getElementById("trimBar");
    if (!startIn || !endIn || !bar) return;
    var range = bar.querySelector(".tb-range");
    var hL = bar.querySelector(".tb-handle.left");
    var hR = bar.querySelector(".tb-handle.right");

    // display window: original start-30s .. original end+30s
    var w0 = Math.max(0, c.origStart - 30);
    var w1 = Math.min(TOTAL, c.origEnd + 30);
    var W = w1 - w0;

    function pct(t) { return Math.min(100, Math.max(0, ((t - w0) / W) * 100)); }

    function updateUI() {
      var l = pct(c.start), r = pct(c.end);
      range.style.left = l + "%";
      range.style.right = (100 - r) + "%";
      hL.style.left = l + "%";
      hR.style.left = r + "%";
      startIn.value = fmtClock(c.start);
      endIn.value = fmtClock(c.end);
      var rangeVal = document.getElementById("statRangeVal");
      var durVal = document.getElementById("statDurVal");
      if (rangeVal) rangeVal.textContent = fmtClock(c.start) + " – " + fmtClock(c.end);
      if (durVal) durVal.textContent = fmtDur(c.end - c.start);
      var rowRange = clipList.querySelector('.clip-row[data-id="' + c.id + '"] .c-range');
      if (rowRange) rowRange.textContent = fmtClock(c.start) + "–" + fmtClock(c.end);
      drawTimeline();
    }

    // clamp: within ±5min of original bounds, start < end, inside the video
    function clampStart(t) {
      t = Math.max(c.origStart - 300, Math.min(c.origStart + 300, t));
      return Math.max(0, Math.min(c.end - 1, t));
    }
    function clampEnd(t) {
      t = Math.max(c.origEnd - 300, Math.min(c.origEnd + 300, t));
      return Math.min(TOTAL, Math.max(c.start + 1, t));
    }

    function commitInput(which) {
      var el = which === "start" ? startIn : endIn;
      var t = parseHMS(el.value);
      if (t === null) { updateUI(); return; } // revert unparsable input
      if (which === "start") c.start = clampStart(t);
      else c.end = clampEnd(t);
      updateUI();
    }
    startIn.addEventListener("change", function () { commitInput("start"); });
    endIn.addEventListener("change", function () { commitInput("end"); });
    [startIn, endIn].forEach(function (el) {
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") el.blur(); });
    });

    function startDrag(which) {
      return function (e) {
        e.preventDefault();
        function move(ev) {
          var r = bar.getBoundingClientRect();
          var frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
          var t = Math.round(w0 + frac * W);
          if (which === "left") c.start = clampStart(t);
          else c.end = clampEnd(t);
          updateUI();
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      };
    }
    hL.addEventListener("mousedown", startDrag("left"));
    hR.addEventListener("mousedown", startDrag("right"));

    updateUI();
  }

  // ---- caption preview ----------------------------------------
  function captionOverlayHTML(c) {
    var words = c.trigger.split(/\s+/).slice(0, 5);
    var inner;
    if (CAPTION_STYLE === "karaoke") {
      var half = Math.ceil(words.length / 2);
      inner = '<span class="k-hit">' + escapeHtml(words.slice(0, half).join(" ")) + '</span> ' +
        escapeHtml(words.slice(half).join(" ")) + '&hellip;';
    } else {
      inner = escapeHtml(words.join(" ")) + '&hellip;';
    }
    return '<span class="cap-overlay ' + CAPTION_STYLE + '"><span class="cap-line">' + inner + '</span></span>';
  }

  function setCaptionStyle(style) {
    if (CAPTION_STYLES.indexOf(style) === -1) return;
    CAPTION_STYLE = style;
    var sel = document.getElementById("capStyleSelect");
    if (sel) sel.value = style; // keep the Settings select in sync
    renderDetails();
  }

  // ---- re-score (mock, deterministic per clip id) ---------------
  function rescoreClip(id, btn) {
    var c = findClip(id);
    if (!c) return;
    btn.disabled = true;
    btn.classList.add("mono");
    btn.textContent = "scoring…";
    setTimeout(function () {
      var h = 0;
      for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      var mag = 0.1 + (h % 4) * 0.1;        // 0.1 .. 0.4
      var sign = (h & 1) ? 1 : -1;
      c.score = Math.min(10, Math.max(0, Math.round((c.score + sign * mag) * 10) / 10));
      renderClips(); // row badge + count line
      if (state.selectedClipId === id) renderDetails(); // stat row + button restore
    }, 900);
  }

  function statRow(label, value, cls, id) {
    return '<div class="stat-row"><span class="s-label">' + label + '</span>' +
      '<span class="s-value' + (cls ? " " + cls : "") + '"' + (id ? ' id="' + id + '"' : '') + '>' + value + '</span></div>';
  }

  // ============================================================
  //  Render: right panel — Export
  // ============================================================
  var exportView = document.getElementById("exportView");

  function exportName(c) {
    var h = Math.floor(c.start / 3600);
    var m = Math.floor((c.start % 3600) / 60);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return "subathon_finale_" + pad(h) + pad(m) + ".mp4";
  }

  function renderExport() {
    var approved = CLIPS.filter(function (c) { return c.state === "approved"; });
    var pending = 0;
    var html = '<div class="export-scroll">';
    if (approved.length === 0) {
      html += '<p class="placeholder">No approved clips yet.</p>';
    }
    approved.forEach(function (c, i) {
      var st = EXPORT_STATUS[c.id] || { status: "pending" };
      if (st.status === "pending") pending++;
      html += '<div class="export-row">';
      html += '<span class="e-glyph">' + PLATFORM_GLYPH[EXPORT_PLATFORMS[i % EXPORT_PLATFORMS.length]] + '</span>';
      html += '<span class="e-name">' + exportName(c) + '</span>';
      html += renderStatusChip(st);
      html += '</div>';
    });
    html += '</div>';
    html += '<div class="export-scroll export-footer"><button class="btn">Export all (' + pending + ')</button></div>';
    exportView.innerHTML = html;
  }

  function renderStatusChip(e) {
    if (e.status === "done")
      return '<span class="status-chip done"><span class="dot"></span>done</span>';
    if (e.status === "exporting")
      return '<span class="status-chip exporting">exporting ' + e.pct + '%<span class="mini-bar"></span></span>';
    return '<span class="status-chip">pending</span>';
  }

  // ============================================================
  //  Render: queue tab
  // ============================================================
  var queueList = document.getElementById("queueList");

  function renderQueue() {
    var html = "";
    QUEUE.forEach(function (q) {
      html += '<div class="queue-card">';
      html += '<span class="q-name">' + escapeHtml(q.name) + '</span>';
      html += '<div class="q-mid">';
      if (q.error) {
        html += '<span class="q-stage error"><i class="q-dot" style="background:var(--coral)"></i>ERROR</span>';
      } else if (q.pct >= 100) {
        html += '<span class="q-stage complete"><i class="q-dot"></i>COMPLETE</span>';
      } else {
        html += '<span class="q-stage">' + q.stage + '</span>';
      }
      html += '<span class="q-pct mono">' + (q.error ? "" : q.pct + '%') + '</span>';
      html += '</div>';
      if (!q.error && q.pct < 100) html += '<div class="q-bar"><span style="width:' + q.pct + '%"></span></div>';
      if (q.error) html += '<div class="q-error">' + escapeHtml(q.error) + '</div>';
      html += '</div>';
    });
    queueList.innerHTML = html;
  }

  // ============================================================
  //  Add video modal (remote sources are first-class; nothing is
  //  downloaded — sources are analyzed in place)
  // ============================================================
  var modal = document.getElementById("addModal");
  var modalInput = document.getElementById("addModalInput");
  var modalAddBtn = document.getElementById("modalAdd");
  var urlNote = document.getElementById("urlNote");

  function detectSource(url) {
    url = String(url || "").trim();
    if (!url) return null;
    if (/(youtube\.com\/watch\?[^\s]*v=|youtu\.be\/)[\w-]+/i.test(url)) return { platform: "youtube", kind: "youtube video" };
    if (/twitch\.tv\/videos\/\d+/i.test(url)) return { platform: "twitch", kind: "twitch vod" };
    if (/twitch\.tv\/[A-Za-z0-9_]+/i.test(url)) return { platform: "twitch", kind: "twitch channel" };
    return { invalid: true };
  }

  function remoteName(url, src) {
    var m;
    if (src.platform === "youtube") {
      m = url.match(/(?:v=|youtu\.be\/)([\w-]+)/i);
      return "yt_" + (m ? m[1] : "video");
    }
    m = url.match(/twitch\.tv\/videos\/(\d+)/i);
    if (m) return "twitch_vod_" + m[1];
    m = url.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
    return (m ? m[1] : "twitch") + "_live";
  }

  function updateUrlNote() {
    var src = detectSource(modalInput.value);
    if (!src) {
      urlNote.className = "url-note hidden";
      modalAddBtn.disabled = true;
      return;
    }
    if (src.invalid) {
      urlNote.className = "url-note invalid";
      urlNote.textContent = "unsupported source";
      modalAddBtn.disabled = true;
    } else {
      urlNote.className = "url-note";
      urlNote.innerHTML = '<span class="e-glyph">' + PLATFORM_GLYPH[src.platform] + '</span>' +
        '<span>' + src.kind + ' &middot; remote source &mdash; processed in place, no download</span>';
      modalAddBtn.disabled = false;
    }
  }

  function openModal() {
    modal.classList.remove("hidden");
    updateUrlNote();
    modalInput.focus();
  }
  function closeModal() {
    modal.classList.add("hidden");
    modalInput.value = "";
  }

  function wireModal() {
    document.getElementById("addVideoBtn").addEventListener("click", openModal);
    document.getElementById("modalCancel").addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
    modalInput.addEventListener("input", updateUrlNote);
    modalInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
      if (e.key === "Enter" && !modalAddBtn.disabled) modalAddBtn.click();
    });
    modalAddBtn.addEventListener("click", function () {
      var src = detectSource(modalInput.value);
      if (!src || src.invalid) return;
      var url = modalInput.value.trim();

      // Real backend path: POST /api/ingest, drive the queue off live status.
      if (backendOnline) {
        ingestUrl(url).catch(function (e) {
          QUEUE.push({ name: url, jobId: null, stage: "ERROR", pct: 0,
                       error: String((e && e.message) || e) });
          renderQueue();
        });
        closeModal();
        return;
      }

      // Mock fallback (backend unreachable) — unchanged behavior.
      var name = remoteName(url, src);
      // appears in the library as a remote source, analyzed in place
      TREE[1].items.push({ id: "p" + Date.now(), name: name, remote: true });
      renderTree();
      QUEUE.push({ name: name, stage: "DETECTING", pct: 8 });
      renderQueue();
      closeModal();
    });
  }

  // ============================================================
  //  Keyboard navigation
  // ============================================================
  function moveSelection(dir) {
    var idx = -1;
    for (var i = 0; i < CLIPS.length; i++) {
      if (CLIPS[i].id === state.selectedClipId) { idx = i; break; }
    }
    var j = (idx === -1) ? (dir > 0 ? 0 : CLIPS.length - 1) : idx + dir;
    while (j >= 0 && j < CLIPS.length) {
      if (CLIPS[j].state !== "discarded") {
        selectClip(CLIPS[j].id);
        var row = clipList.querySelector(".clip-row.active");
        if (row) row.scrollIntoView({ block: "nearest" });
        return;
      }
      j += dir;
    }
  }

  function wireKeyboard() {
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) {
        closeModal();
        return;
      }
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (!modal.classList.contains("hidden")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "a" || e.key === "A") {
        if (state.selectedClipId) toggleClipState(state.selectedClipId, "approve");
      } else if (e.key === "d" || e.key === "D") {
        if (state.selectedClipId) toggleClipState(state.selectedClipId, "discard");
      }
    });
  }

  // ============================================================
  //  Settings wiring
  // ============================================================
  function wireSettings() {
    var sens = document.getElementById("sensSlider");
    var sensVal = document.getElementById("sensVal");
    sens.addEventListener("input", function () {
      sensVal.textContent = parseFloat(sens.value).toFixed(2);
    });
    var capTog = document.getElementById("capDefaultToggle");
    capTog.addEventListener("click", function () {
      capTog.classList.toggle("on");
    });
    // caption style select <-> Details segmented control (two-way sync)
    var styleSel = document.getElementById("capStyleSelect");
    styleSel.value = CAPTION_STYLE;
    styleSel.addEventListener("change", function () {
      setCaptionStyle(styleSel.value);
    });
  }

  // ============================================================
  //  Resizable panels
  // ============================================================
  var PANEL_DEFAULTS = { sidebar: 260, inspector: 380 };
  var panelW = { sidebar: PANEL_DEFAULTS.sidebar, inspector: PANEL_DEFAULTS.inspector };

  function applyPanelW() {
    document.getElementById("app").style.gridTemplateColumns =
      panelW.sidebar + "px 1fr " + panelW.inspector + "px";
  }

  function wireResize() {
    var handles = [
      { el: document.getElementById("resizeLeft"), side: "sidebar", min: 200, max: 340, dirMul: 1 },
      { el: document.getElementById("resizeRight"), side: "inspector", min: 300, max: 460, dirMul: -1 }
    ];
    handles.forEach(function (h) {
      h.el.addEventListener("mousedown", function (e) {
        e.preventDefault();
        var startX = e.clientX;
        var startW = panelW[h.side];
        h.el.classList.add("dragging");
        document.body.classList.add("col-resizing");
        function move(ev) {
          var w = startW + (ev.clientX - startX) * h.dirMul;
          panelW[h.side] = Math.min(h.max, Math.max(h.min, w));
          applyPanelW();
          drawTimeline(); // explicit redraw; ResizeObserver also covers this
        }
        function up() {
          h.el.classList.remove("dragging");
          document.body.classList.remove("col-resizing");
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
      h.el.addEventListener("dblclick", function () {
        panelW[h.side] = PANEL_DEFAULTS[h.side];
        applyPanelW();
        drawTimeline();
      });
    });
  }

  // ============================================================
  //  Timeline canvas
  // ============================================================
  var strip = document.getElementById("timelineStrip");
  var canvas = document.getElementById("timelineCanvas");
  var ctx = canvas.getContext("2d");
  var tooltip = document.getElementById("tlTooltip");

  function drawTimeline() {
    // Content box (excludes the strip's 1px borders) so the backing store
    // matches the canvas CSS box exactly — no sub-pixel stretch.
    var w = strip.clientWidth, h = strip.clientHeight;
    if (w === 0) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var padY = 6;
    var floor = h - padY;      // baseline bottom
    var usableH = h - padY * 2;
    var barW = w / NBARS;

    // teal baseline bars
    for (var i = 0; i < NBARS; i++) {
      var v = baseline[i];
      var bh = v * usableH;
      var x = i * barW;
      var alpha = 0.10 + v * 0.55; // dim low values
      ctx.fillStyle = "rgba(59,169,156," + alpha.toFixed(3) + ")";
      ctx.fillRect(x + barW * 0.15, floor - bh, barW * 0.7, bh);
    }

    // coral spike bars (thinner, brighter, can exceed)
    spikes.forEach(function (sp) {
      var bh = sp.val * (usableH * 1.05);
      var x = sp.idx * barW;
      ctx.fillStyle = "rgba(229,105,94,0.85)";
      ctx.fillRect(x + barW * 0.36, floor - bh, barW * 0.28, bh);
    });

    // candidate markers (1px white line @ 25%)
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    CLIPS.forEach(function (c) {
      if (c.state === "discarded") return;
      var cx = (c.start / TOTAL) * w;
      ctx.fillRect(Math.round(cx), padY, 1, h - padY * 2);
    });

    // selected clip region band
    var sel = findClip(state.selectedClipId);
    if (sel && sel.state !== "discarded") {
      var x1 = (sel.start / TOTAL) * w;
      var x2 = (sel.end / TOTAL) * w;
      // widen minimally for visibility
      if (x2 - x1 < 6) x2 = x1 + 6;
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(x1, 0, x2 - x1, h);
      ctx.fillStyle = "rgba(255,255,255,0.30)";
      ctx.fillRect(Math.round(x1), 0, 1, h);
      ctx.fillRect(Math.round(x2), 0, 1, h);
    }

    // playhead
    var px = w * state.playhead;
    ctx.fillStyle = "#e8e8e8";
    ctx.fillRect(Math.round(px), 0, 1, h);
    ctx.fillRect(Math.round(px) - 2, 0, 5, 4); // square cap
  }

  function updatePreviewTime() {
    var t = state.playhead * TOTAL;
    var timeEl = document.querySelector(".preview-time");
    var fillEl = document.querySelector(".preview-seek-fill");
    if (timeEl) timeEl.textContent = fmtClock(t) + " / " + fmtHMS(TOTAL);
    if (fillEl) fillEl.style.width = (state.playhead * 100).toFixed(1) + "%";
  }

  // hover tooltip + click to select
  function scoreAtX(x, w) {
    var idx = Math.min(NBARS - 1, Math.max(0, Math.floor((x / w) * NBARS)));
    return baseline[idx];
  }

  strip.addEventListener("mousemove", function (e) {
    var rect = strip.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var w = rect.width;
    var t = (x / w) * TOTAL;
    var sc = scoreAtX(x, w) * 10;
    tooltip.classList.remove("hidden");
    tooltip.style.left = Math.min(w - 4, Math.max(4, x)) + "px";
    tooltip.textContent = fmtClock(t) + "  ·  " + sc.toFixed(1);
  });
  strip.addEventListener("mouseleave", function () {
    tooltip.classList.add("hidden");
  });
  strip.addEventListener("click", function (e) {
    var rect = strip.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var w = rect.width;
    var clickT = (x / w) * TOTAL;
    // find nearest candidate within threshold (~2% of total)
    var best = null, bestD = Infinity;
    CLIPS.forEach(function (c) {
      if (c.state === "discarded") return;
      var d = Math.abs(c.start - clickT);
      if (d < bestD) { bestD = d; best = c; }
    });
    if (best && bestD < TOTAL * 0.03) {
      selectClip(best.id);
    } else {
      // scrub: move the playhead to the clicked position
      state.playhead = Math.min(1, Math.max(0, x / w));
      drawTimeline();
      updatePreviewTime();
    }
  });

  // ============================================================
  //  Time ruler
  // ============================================================
  function renderRuler() {
    var ruler = document.getElementById("timeRuler");
    var N = 9; // evenly spaced ticks rescaled to the active duration
    var html = "";
    for (var i = 0; i < N; i++) {
      html += '<span>' + fmtHMS(Math.round((TOTAL * i) / (N - 1))) + '</span>';
    }
    ruler.innerHTML = html;
  }

  // ============================================================
  //  Tab switching (both panels)
  // ============================================================
  function wireTabs(tabsEl, bodySelector) {
    var tabs = tabsEl.querySelectorAll(".tab");
    var body = document.querySelector(bodySelector);
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        var name = tab.getAttribute("data-tab");
        body.querySelectorAll(".tab-view").forEach(function (v) {
          v.classList.toggle("hidden", v.getAttribute("data-view") !== name);
        });
        if (name === "export") renderExport();
      });
    });
  }

  // ============================================================
  //  Play/pause toolbar toggle
  // ============================================================
  var playBtn = document.getElementById("playPauseBtn");
  var isPlaying = false;
  var PLAY_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5V3z"/></svg>';
  var PAUSE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>';
  playBtn.addEventListener("click", function () {
    isPlaying = !isPlaying;
    playBtn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
    playBtn.classList.toggle("playing", isPlaying);
  });

  // ============================================================
  //  Utilities
  // ============================================================
  function findClip(id) {
    for (var i = 0; i < CLIPS.length; i++) if (CLIPS[i].id === id) return CLIPS[i];
    return null;
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ============================================================
  //  Backend integration (real ingestion)
  //  Probes the API on :8971. If unreachable, the whole app stays in
  //  mock mode exactly as before. If reachable, real jobs are merged in
  //  and drive the tree / queue / timeline / candidates.
  // ============================================================
  var API = "http://localhost:8971";
  var backendOnline = false;
  var activeVideoIsReal = false;
  var realJobs = {};     // rowId -> { rowId, jobId, name, sum }
  var pollTimer = null;

  // snapshot of the mock dataset so a mock row can be restored after viewing
  // a real one (closures reference these module vars by name, so reassigning
  // TOTAL / CLIPS / baseline / spikes is picked up everywhere).
  var MOCK = {
    TOTAL: TOTAL, CLIPS: CLIPS, baseline: baseline, spikes: spikes,
    selectedClipId: state.selectedClipId,
    sourceName: "subathon_finale.mp4",
    sourceMeta: "1920×1080 · 4:01:22"
  };

  function apiFetch(path, opts, timeoutMs) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000);
    opts = opts || {};
    opts.signal = ctrl.signal;
    return fetch(API + path, opts).then(function (r) {
      clearTimeout(to);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }, function (e) { clearTimeout(to); throw e; });
  }

  function stageLabel(status) {
    // generic: render whatever uppercase stage the API reports
    // (INGESTING / DETECTING / AUDIO / TRANSCRIBING / COMPLETE / ERROR / …)
    return String(status || "").toUpperCase();
  }

  function jobName(sum) {
    return remoteName(sum.url, { platform: sum.platform });
  }

  function findQueue(jobId) {
    for (var i = 0; i < QUEUE.length; i++) {
      if (QUEUE[i].jobId === jobId) return QUEUE[i];
    }
    return null;
  }

  function applyStatusToQueue(q, sum) {
    q.stage = stageLabel(sum.status);
    q.pct = sum.status === "complete" ? 100 : Math.round(sum.progress || 0);
    q.error = sum.error || (sum.status === "error" ? "processing failed" : null);
  }

  function findTreeItem(rowId) {
    for (var i = 0; i < TREE[1].items.length; i++) {
      if (TREE[1].items[i].id === rowId) return TREE[1].items[i];
    }
    return null;
  }

  // Once metadata exists, the tree row shows the real title + duration
  // (still with the remote link glyph). Returns true if the row changed.
  function syncTreeItem(item, sum) {
    var changed = false;
    if (sum.title && item.name !== sum.title) {
      item.name = sum.title;
      changed = true;
    }
    if (sum.duration && item.dur !== fmtHMS(sum.duration)) {
      item.dur = fmtHMS(sum.duration);
      changed = true;
    }
    return changed;
  }

  function registerJob(sum) {
    var rowId = "job_" + sum.id;
    var name = jobName(sum);
    if (!realJobs[rowId]) {
      realJobs[rowId] = { rowId: rowId, jobId: sum.id, name: name, sum: sum };
      var item = { id: rowId, name: name, remote: true, real: true };
      syncTreeItem(item, sum);
      TREE[1].items.push(item);
      var q = { name: name, jobId: sum.id, stage: "INGESTING", pct: 0, error: null };
      applyStatusToQueue(q, sum);
      QUEUE.push(q);
      realJobs[rowId].treeChanged = true;
    } else {
      realJobs[rowId].sum = sum;
      var existing = findQueue(sum.id);
      if (existing) applyStatusToQueue(existing, sum);
      var it = findTreeItem(rowId);
      realJobs[rowId].treeChanged = !!(it && syncTreeItem(it, sum));
    }
    return realJobs[rowId];
  }

  function anyActive() {
    return QUEUE.some(function (q) {
      return q.jobId && q.stage !== "COMPLETE" && !q.error;
    });
  }
  function ensurePolling() {
    if (!pollTimer) pollTimer = setInterval(pollJobs, 2000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function pollJobs() {
    apiFetch("/api/videos", {}, 4000).then(function (jobs) {
      var treeDirty = false;
      jobs.forEach(function (sum) {
        var rj = registerJob(sum);   // adds new rows or updates existing ones
        if (rj.treeChanged) treeDirty = true;
      });
      if (treeDirty) renderTree();
      renderQueue();
      if (!anyActive()) stopPolling();
    }, function () { /* transient; keep polling */ });
  }

  function ingestUrl(url) {
    var src = detectSource(url);
    return apiFetch("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url })
    }, 8000).then(function (res) {
      if (res.error) throw new Error(res.error);
      var rowId = "job_" + res.id;
      if (realJobs[rowId]) {
        // backend deduped to an existing job — select its row, don't append
        state.sidebarActiveId = rowId;
        renderTree();
        onSidebarSelect(rowId);
        return res;
      }
      registerJob({
        id: res.id, url: url, platform: src ? src.platform : "",
        title: null, duration: 0, status: res.status || "ingesting",
        progress: 0, candidateCount: 0, error: null
      });
      renderTree();
      renderQueue();
      ensurePolling();
      return res;
    });
  }

  function padBaseline(arr) {
    var out = [];
    for (var i = 0; i < NBARS; i++) out.push(arr && arr[i] != null ? arr[i] : 0);
    return out;
  }

  function applyDataset(d) {
    TOTAL = d.duration || 1;
    activeSignal = (d.signals && d.signals.length)
      ? d.signals.join(" + ") : (d.signal || null);
    CLIPS = (d.candidates || []).map(function (c) {
      return {
        id: c.id, start: c.start, end: c.end, score: c.score,
        state: c.state || "none", excerpt: c.excerpt || "",
        transcript: c.transcript || "", trigger: c.trigger || "",
        reason: c.reason || "", signal: c.signal || "",
        signals: c.signals || [], transcribed: !!c.transcribed,
        origStart: c.start, origEnd: c.end
      };
    });
    var tl = d.timeline || { baseline: [], spikes: [] };
    baseline = (tl.baseline && tl.baseline.length === NBARS)
      ? tl.baseline.slice() : padBaseline(tl.baseline);
    spikes = (tl.spikes || []).map(function (s) { return { idx: s.idx, val: s.val }; });
    state.selectedClipId = CLIPS.length ? CLIPS[0].id : null;
    state.playhead = 0;
    activeVideoIsReal = true;

    document.getElementById("sourceName").textContent = d.title || "remote source";
    document.getElementById("sourceMeta").textContent =
      (d.platform || "remote") + " · " + fmtHMS(d.duration || 0);

    reRenderActive();
  }

  function reRenderActive() {
    renderClips();
    renderDetails();
    renderExport();
    renderRuler();
    drawTimeline();
    updatePreviewTime();
  }

  function loadRealVideo(rj) {
    apiFetch("/api/videos/" + rj.jobId, {}, 6000).then(function (d) {
      if (!d || d.error || d.status !== "complete") return;
      applyDataset(d);
    }, function () { /* ignore */ });
  }

  function restoreMock() {
    if (!activeVideoIsReal) return;
    TOTAL = MOCK.TOTAL;
    CLIPS = MOCK.CLIPS;
    baseline = MOCK.baseline;
    spikes = MOCK.spikes;
    activeSignal = null;
    activeVideoIsReal = false;
    state.selectedClipId = MOCK.selectedClipId;
    document.getElementById("sourceName").textContent = MOCK.sourceName;
    document.getElementById("sourceMeta").textContent = MOCK.sourceMeta;
    reRenderActive();
  }

  function onSidebarSelect(id) {
    if (!backendOnline) return;
    var rj = realJobs[id];
    if (rj) {
      var q = findQueue(rj.jobId);
      if (q && q.stage === "COMPLETE") loadRealVideo(rj);
    } else {
      restoreMock();
    }
  }

  function probeBackend() {
    apiFetch("/api/videos", {}, 1200).then(function (jobs) {
      backendOnline = true;
      (jobs || []).forEach(registerJob);
      if (jobs && jobs.length) {
        renderTree();
        renderQueue();
        if (anyActive()) ensurePolling();
      }
    }, function () { backendOnline = false; });
  }

  // ============================================================
  //  Init
  // ============================================================
  renderTree();
  renderClips();
  renderDetails();
  renderExport();
  renderQueue();
  renderRuler();
  drawTimeline();
  updatePreviewTime(); // keep timecode/seekbar consistent with the playhead
  wireModal();
  wireKeyboard();
  wireSettings();
  wireResize();

  wireTabs(document.getElementById("sidebarTabs"), ".sidebar-body");
  wireTabs(document.getElementById("inspectorTabs"), ".inspector-body");

  // Probe the real backend; stays in mock mode if it's unreachable.
  probeBackend();

  // Redraw whenever the strip's box changes size (handles the initial
  // layout-settle race and window resizes deterministically).
  if (typeof ResizeObserver !== "undefined") {
    var ro = new ResizeObserver(function () { drawTimeline(); });
    ro.observe(strip);
  } else {
    window.addEventListener("resize", drawTimeline);
  }
  // Belt-and-suspenders: redraw after layout has definitely happened.
  setTimeout(drawTimeline, 0);
})();
