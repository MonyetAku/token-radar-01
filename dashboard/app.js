// Token Radar — radar-2 dashboard, rewritten.
//
// The page is a static file: index.html loads ../data.js (written by main.ts
// from the same ranked board) and this script, and nothing else is fetched.
// Everything on screen comes from window.RADAR: the 178-row ranked board,
// the live-token set, and the model constants the board was scored with.
//
// The page scores every row a second time, from the snapshot figures, with
// the same arithmetic lib/model.ts uses — so a row's detail view proves the
// number on the board instead of just repeating it. The farm plan is derived
// the same way main.ts derives it: a protocol's category, chains, TVL and
// age decide the action, the capital, the hold and every cost and time.
// No protocol name is special-cased anywhere on this page.

(function () {
  "use strict";

  var RADAR = window.RADAR;
  var mount = document.getElementById("board");
  if (!RADAR || !mount) return;

  // --- view state -----------------------------------------------------------
  // Only the search, the selected protocol and the two dropdown filters are
  // written back into the URL hash, so a filtered view is a linkable view.
  var view = {
    query: "",
    category: "all",
    chain: "all",
    minTvl: 0,
    watchlistOnly: false,
    tab: "pre-token",
    sortKey: "implied",
    sortDir: -1,
    selected: null,
  };

  var watchlist = {};
  (RADAR.watchlist || []).forEach(function (slug) {
    watchlist[slug] = true;
  });

  // --- small helpers --------------------------------------------------------
  var usdWhole = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function missing(value) {
    return value === null || value === undefined || !isFinite(value);
  }

  // $547.3M, $2.75B, $812K, or the whole-dollar format for small amounts.
  function fmtMoney(n) {
    if (missing(n)) return "n/a";
    var mag = Math.abs(n);
    if (mag >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (mag >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (mag >= 1e3) return "$" + Math.round(n / 1e3) + "K";
    return usdWhole.format(n);
  }

  function fmtChange(n) {
    if (missing(n)) return "n/a";
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return "unknown";
    if (days >= 365) return (days / 365).toFixed(1) + "y";
    return Math.max(0, Math.round(days)) + "d";
  }

  function fmtMultiple(n) {
    if (missing(n) || n === 0) return "n/a";
    return n.toFixed(2) + "x";
  }

  function fmtChains(row) {
    var chains = row.chains || [];
    return chains.length ? chains.slice(0, 2).join(", ") : "an unnamed chain";
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  // --- the model, run again in the page ------------------------------------
  // radar-2, identical arithmetic to lib/model.ts: growth is the week's
  // change clamped to [-50, +100], maturity grows with the square root of
  // the age with no token, breadth pays 4% per extra chain up to four, and
  // size is a diminishing multiple so giants do not win on size alone.
  function scoreParts(row, model) {
    var growthPct = clamp(
      row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d,
      model.growth_floor,
      model.growth_cap
    );
    var age =
      row.age_days === null || row.age_days === undefined
        ? model.unknown_age_days
        : row.age_days;
    var growthMult = 1 + (growthPct / 100) * model.growth_weight;
    var maturity =
      model.maturity_floor +
      model.maturity_range *
        Math.sqrt(
          Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days
        );
    var breadth =
      1 +
      model.breadth_per_chain *
        Math.min(
          Math.max((row.chains || []).length - 1, 0),
          model.breadth_max_chains
        );
    var size = clamp(
      Math.pow(
        model.size_reference_usd / Math.max(row.tvl_usd, 1),
        model.size_exponent
      ),
      model.size_floor,
      model.size_cap
    );
    return {
      growthPct: growthPct,
      growthMult: growthMult,
      maturity: maturity,
      breadth: breadth,
      size: size,
    };
  }

  function scoreRow(row, model) {
    var parts = scoreParts(row, model);
    return Math.max(
      1,
      Math.round(
        row.tvl_usd *
          model.base_multiple *
          parts.growthMult *
          parts.maturity *
          parts.breadth *
          parts.size
      )
    );
  }

  // --- the farm plan, derived from the protocol's own record ----------------
  // Eight steps, each an action with a cost and a time. The first chain a
  // protocol names is where the farming happens; the capital follows its
  // TVL; the hold follows its age. The category picks the action and the
  // risk check from the rule tables below, first matching rule wins, and
  // nothing here names a protocol.

  function firstChain(row) {
    return row.chains && row.chains.length > 0 ? row.chains[0] : "its main chain";
  }

  function capitalFor(row) {
    if (row.tvl_usd >= 5e9) return 250;
    if (row.tvl_usd >= 1e9) return 150;
    if (row.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  // Each rule is a set of category words and the action it earns. The order
  // is the order the checks run in: a curator vault beats a lending market,
  // and a chain of its own beats a generic pool.
  var ACTION_RULES = [
    [
      ["risk curator", "curator", "allocator", "onchain capital"],
      function (name, capital, chain) {
        return (
          "Deposit $" +
          capital +
          " into a " +
          name +
          " vault on " +
          chain +
          " and keep the shares while the vault earns."
        );
      },
    ],
    [
      ["rwa"],
      function (name, capital, chain) {
        return (
          "Mint $" +
          capital +
          " of the protocol's yield-bearing asset on " +
          chain +
          " and hold it in the farming wallet."
        );
      },
    ],
    [
      ["basis trad"],
      function (name, capital, chain) {
        return (
          "Deposit $" +
          capital +
          " of USDC into " +
          name +
          "'s basis strategy on " +
          chain +
          " and keep the position open."
        );
      },
    ],
    [
      ["lend", "cdp", "collateral"],
      function (name, capital, chain) {
        return (
          "Supply $" +
          capital +
          " of USDC to " +
          name +
          " on " +
          chain +
          " and keep the position open."
        );
      },
    ],
    [
      ["chain"],
      function (name, capital, chain) {
        return (
          "Use " +
          name +
          " on " +
          chain +
          ": bridge $" +
          capital +
          " in, hold the native asset, and make one transaction a week."
        );
      },
    ],
    [
      ["dex", "yield", "leveraged farm"],
      function (name, capital, chain) {
        return (
          "Provide $" +
          capital +
          " of liquidity to " +
          name +
          "'s main pool on " +
          chain +
          " and keep the position open."
        );
      },
    ],
    [
      ["restak"],
      function (name, capital, chain) {
        return (
          "Restake $" +
          capital +
          " through " +
          name +
          " on " +
          chain +
          " and keep the receipt token in the farming wallet."
        );
      },
    ],
    [
      ["staking pool", "staking"],
      function (name, capital, chain) {
        return (
          "Stake $" +
          capital +
          " through " +
          name +
          " on " +
          chain +
          " and keep the receipt."
        );
      },
    ],
    [
      ["perpetual", "derivative"],
      function (name, capital, chain) {
        return (
          "Deposit $" +
          capital +
          " of USDC as margin on " +
          name +
          " and open one small hedged position."
        );
      },
    ],
    [
      ["prediction"],
      function (name, capital, chain) {
        return (
          "Fund $" +
          capital +
          " and place one market position on " +
          name +
          "."
        );
      },
    ],
    [
      ["stable"],
      function (name, capital, chain) {
        return (
          "Mint or deposit $" +
          capital +
          " of the stable asset through " +
          name +
          " on " +
          chain +
          "."
        );
      },
    ],
    [
      ["insurance"],
      function (name, capital, chain) {
        return (
          "Buy $" +
          capital +
          " of cover from " +
          name +
          " on " +
          chain +
          " and keep the policy active."
        );
      },
    ],
    [
      ["payment"],
      function (name, capital, chain) {
        return (
          "Route $" +
          capital +
          " of payments through " +
          name +
          " on " +
          chain +
          " and keep the account active."
        );
      },
    ],
    [
      ["governance"],
      function (name, capital, chain) {
        return (
          "Deposit $" +
          capital +
          " into " +
          name +
          " on " +
          chain +
          " and vote in its next governance round."
        );
      },
    ],
    [
      ["cedefi"],
      function (name, capital, chain) {
        return (
          "Deposit $" +
          capital +
          " into " +
          name +
          "'s managed strategy on " +
          chain +
          " and keep the position open."
        );
      },
    ],
  ];

  function actionFor(row, capital, chain) {
    var category = (row.category || "").toLowerCase();
    for (var i = 0; i < ACTION_RULES.length; i++) {
      var rule = ACTION_RULES[i];
      var words = rule[0];
      for (var j = 0; j < words.length; j++) {
        if (category.indexOf(words[j]) >= 0) {
          return rule[1](row.name, capital, chain);
        }
      }
    }
    return (
      "Deposit $" +
      capital +
      " of USDC into " +
      row.name +
      " on " +
      chain +
      " and keep the position open."
    );
  }

  // The weekly risk check, by the same category words.
  var RISK_RULES = [
    [
      ["lend", "cdp", "collateral"],
      "Check the position's health factor before any new borrow: a liquidation costs more than any airdrop.",
    ],
    [
      ["perpetual", "derivative", "basis trad"],
      "Check the funding rate and the position's margin before adding size: a crowded trade can turn against you fast.",
    ],
    [
      ["dex", "yield", "leveraged farm"],
      "Check the pool's impermanent loss and the reward rate each week: a pool that pays less than it loses is not worth holding.",
    ],
    [
      ["rwa", "risk curator", "curator", "allocator"],
      "Read the vault's latest audit and its underlying assets each week: unwind if the vault stops publishing updates.",
    ],
  ];

  function riskFor(row) {
    var category = (row.category || "").toLowerCase();
    for (var i = 0; i < RISK_RULES.length; i++) {
      var rule = RISK_RULES[i];
      var words = rule[0];
      for (var j = 0; j < words.length; j++) {
        if (category.indexOf(words[j]) >= 0) return rule[1];
      }
    }
    return "Check the protocol's audits and its TVL trend each week: unwind if TVL falls by half or the app stops publishing updates.";
  }

  // One farm step as the page shows it: the action in bold, then its cost
  // and time. The combined line is kept to the same 20..600 characters the
  // board's own steps keep.
  function joinStep(action, cost, time) {
    var line = action + " Cost: " + cost + ". Time: " + time + ".";
    if (line.length > 600) line = line.slice(0, 596) + "...";
    if (line.length < 20) {
      line += " Hold the position and check the protocol's own page.";
    }
    var cut = line.indexOf(" Cost: ");
    return {
      action: cut >= 0 ? line.slice(0, cut) : line,
      meta: cut >= 0 ? line.slice(cut + 1) : "",
    };
  }

  function planSteps(row) {
    var chain = firstChain(row);
    var capital = capitalFor(row);
    var hold = holdFor(row.age_days);
    var gas = capital >= 150 ? 8 : 4;
    return [
      joinStep(
        "Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.",
        "under $3 of gas for the first transaction",
        "5 minutes"
      ),
      joinStep(
        "Move $" +
          capital +
          " of USDC to " +
          chain +
          " through the protocol's own app or a bridge you already trust, and check the received amount before you continue.",
        "about $" + gas + " of gas to bridge",
        "10 minutes"
      ),
      joinStep(
        actionFor(row, capital, chain),
        "$" + capital + " of capital and about $" + gas + " of gas",
        "15 minutes to set up"
      ),
      joinStep(
        "Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the position stays active.",
        "about $2 of gas a week",
        "10 minutes a week"
      ),
      joinStep(
        "Open the protocol's points or rewards page each week, finish the task it lists, and vote when a governance round opens.",
        "no fee to check, about $2 of gas to vote",
        "15 minutes a week"
      ),
      joinStep(
        "Hold the position for at least " +
          hold +
          " days so the activity is counted in more than one snapshot.",
        "the $" + capital + " stays in the position",
        hold + " days"
      ),
      joinStep(riskFor(row), "nothing to check", "10 minutes a week"),
      joinStep(
        "Claim only from the link the protocol itself publishes, never from a message or an ad, and write the wallet, the dates and every transaction in a farm log.",
        "no fee to check, and never pay to claim",
        "10 minutes"
      ),
    ];
  }

  // Short warnings shown as chips above a protocol's detail.
  function rowFlags(row) {
    var flags = [];
    if (
      row.change_7d !== null &&
      row.change_7d !== undefined &&
      row.change_7d > 100
    ) {
      flags.push(
        "Growth spike: +" +
          row.change_7d.toFixed(0) +
          "% in 7 days, treat as a data point, not a trend"
      );
    }
    if (
      row.change_7d !== null &&
      row.change_7d !== undefined &&
      row.change_7d < -25
    ) {
      flags.push("Falling: TVL down more than 25% in 7 days");
    }
    if (row.age_days === null || row.age_days === undefined) {
      flags.push("Age unknown: first-listed date not reported");
    } else if (row.age_days < 90) {
      flags.push("Young: listed under 90 days ago");
    }
    if (!row.chains || row.chains.length <= 1) flags.push("Single chain");
    if (row.tvl_usd < 1e7) flags.push("Small: under $10M TVL");
    if (watchlist[row.slug]) flags.push("On the watchlist");
    return flags;
  }

  // --- filtering, sorting, and the URL hash ---------------------------------
  function applyFilters() {
    var needle = view.query.trim().toLowerCase();
    return RADAR.rows.filter(function (row) {
      if (view.watchlistOnly && !watchlist[row.slug]) return false;
      if (view.category !== "all" && row.category !== view.category) {
        return false;
      }
      if (
        view.chain !== "all" &&
        !(row.chains || []).indexOf(view.chain) >= 0
      ) {
        return false;
      }
      if (view.minTvl && row.tvl_usd < view.minTvl) return false;
      if (!needle) return true;
      var haystack = [
        row.name,
        row.slug,
        row.category,
        (row.chains || []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }

  function sortRows(list) {
    var key = view.sortKey;
    var dir = view.sortDir;
    return list.slice().sort(function (a, b) {
      var av;
      var bv;
      if (key === "name") {
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
      } else if (key === "tvl") {
        av = a.tvl_usd;
        bv = b.tvl_usd;
      } else if (key === "growth") {
        av = a.change_7d === null ? -Infinity : a.change_7d;
        bv = b.change_7d === null ? -Infinity : b.change_7d;
      } else if (key === "age") {
        av = a.age_days === null ? Infinity : a.age_days;
        bv = b.age_days === null ? Infinity : b.age_days;
      } else if (key === "multiple") {
        av = a.implied_value_usd / a.tvl_usd;
        bv = b.implied_value_usd / b.tvl_usd;
      } else {
        av = a.implied_value_usd;
        bv = b.implied_value_usd;
      }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function readHash() {
    var raw = window.location.hash.replace(/^#/, "");
    if (!raw) return;
    var params = new URLSearchParams(raw);
    if (params.get("q")) view.query = params.get("q");
    if (params.get("p")) view.selected = params.get("p");
    if (params.get("category")) view.category = params.get("category");
    if (params.get("chain")) view.chain = params.get("chain");
  }

  function saveHash() {
    var params = new URLSearchParams();
    if (view.query) params.set("q", view.query);
    if (view.category !== "all") params.set("category", view.category);
    if (view.chain !== "all") params.set("chain", view.chain);
    if (view.selected) params.set("p", view.selected);
    var next = params.toString();
    var url = next
      ? "#" + next
      : window.location.pathname + window.location.search;
    window.history.replaceState(null, "", url);
  }

  // --- rendering ------------------------------------------------------------
  // The page is rendered as HTML strings and handed to the browser in one
  // go; one delegated listener on the mount answers every click, input and
  // change inside it, instead of a listener per row.

  function headerHtml() {
    return (
      '<header class="top">' +
      '<div class="brand"><span class="mark"></span>' +
      '<span class="brand-name">Token Radar · radar-2</span></div>' +
      '<div class="top-meta">' +
      "<span>Snapshot " +
      esc(RADAR.as_of) +
      "</span>" +
      "<span>DefiLlama protocol index</span>" +
      "<span>" +
      esc(RADAR.model_version) +
      " model</span>" +
      "</div></header>"
    );
  }

  function introHtml() {
    var floorM = Math.round(RADAR.floor_usd / 1e6);
    return (
      '<section class="lede"><div>' +
      "<h1>" +
      RADAR.watchlist_size +
      " watchlist protocols, ranked by implied value</h1>" +
      "<p>The watchlist is the floor: every protocol with at least $" +
      floorM +
      "M of TVL and no token on record. The early radar adds " +
      RADAR.early_size +
      " more launch candidates below that floor, each checked against the watchlist’s own rule, " +
      "so no wrapped, staked or bridged product is ever presented as a token that does not exist yet. " +
      "Implied value is a model, not a promise.</p></div>" +
      '<div class="facts">' +
      factHtml("Watchlist covered", RADAR.watchlist_size + " / " + RADAR.watchlist_size) +
      factHtml("Launch candidates ranked", String(RADAR.board_size)) +
      factHtml("Early rows below the floor", String(RADAR.early_size)) +
      factHtml("Live-token protocols set aside", String(RADAR.live_size)) +
      "</div></section>"
    );
  }

  function factHtml(label, value) {
    return (
      '<div class="fact"><span>' +
      esc(label) +
      "</span><b>" +
      esc(value) +
      "</b></div>"
    );
  }

  function topThreeHtml() {
    var cards = RADAR.rows.slice(0, 3).map(function (row) {
      return (
        '<button type="button" class="spot-card" data-open="' +
        esc(row.slug) +
        '">' +
        '<span class="rank">Rank ' +
        row.rank +
        "</span>" +
        "<h3>" +
        esc(row.name) +
        "</h3>" +
        '<div class="big">' +
        fmtMoney(row.implied_value_usd) +
        "</div>" +
        '<div class="sub">' +
        fmtMoney(row.tvl_usd) +
        " TVL · " +
        fmtChange(row.change_7d) +
        " in 7d · " +
        esc(row.category || "Other") +
        "</div></button>"
      );
    });
    return (
      '<section class="spot" aria-label="Top three protocols">' +
      cards.join("") +
      "</section>"
    );
  }

  function optionHtml(value, label, selectedValue) {
    return (
      '<option value="' +
      esc(value) +
      '"' +
      (String(value) === String(selectedValue) ? " selected" : "") +
      ">" +
      esc(label) +
      "</option>"
    );
  }

  function filtersHtml(shown) {
    var categories = Array.from(
      new Set(
        RADAR.rows.map(function (row) {
          return row.category || "Other";
        })
      )
    ).sort();
    var chains = Array.from(
      new Set(
        RADAR.rows.flatMap(function (row) {
          return row.chains || [];
        })
      )
    ).sort();
    var tvlChoices = [
      ["0", "Any TVL"],
      ["10000000", "TVL $10M+"],
      ["50000000", "TVL $50M+"],
      ["100000000", "TVL $100M+"],
      ["1000000000", "TVL $1B+"],
    ];
    var count =
      view.tab === "pre-token"
        ? shown + " rows shown"
        : RADAR.live.length + " live-token protocols";
    return (
      '<div class="controls">' +
      '<div class="field"><label for="q">Search</label>' +
      '<input type="search" id="q" placeholder="Search name, category or chain" ' +
      'aria-label="Search the board" value="' +
      esc(view.query) +
      '"></div>' +
      '<div class="field"><label for="category">Category</label>' +
      '<select id="category" aria-label="Filter by category">' +
      optionHtml("all", "All categories", view.category) +
      categories
        .map(function (c) {
          return optionHtml(c, c, view.category);
        })
        .join("") +
      "</select></div>" +
      '<div class="field"><label for="chain">Chain</label>' +
      '<select id="chain" aria-label="Filter by chain">' +
      optionHtml("all", "All chains", view.chain) +
      chains
        .map(function (c) {
          return optionHtml(c, c, view.chain);
        })
        .join("") +
      "</select></div>" +
      '<div class="field"><label for="mintvl">Size</label>' +
      '<select id="mintvl" aria-label="Minimum TVL">' +
      tvlChoices
        .map(function (choice) {
          return optionHtml(choice[0], choice[1], String(view.minTvl));
        })
        .join("") +
      "</select></div>" +
      '<label class="check"><input type="checkbox" id="watchlist-only"' +
      (view.watchlistOnly ? " checked" : "") +
      ">Watchlist only</label>" +
      '<div class="field"><span class="sub">Token status</span>' +
      '<div class="tabs">' +
      '<button type="button" data-tab="pre-token" aria-pressed="' +
      (view.tab === "pre-token" ? "true" : "false") +
      '">Pre-token</button>' +
      '<button type="button" data-tab="live" aria-pressed="' +
      (view.tab === "live" ? "true" : "false") +
      '">Live token</button>' +
      "</div></div>" +
      '<span class="count">' +
      esc(count) +
      "</span></div>"
    );
  }

  function sortButtonHtml(key, label) {
    var marker =
      view.sortKey === key
        ? '<span aria-hidden="true">' + (view.sortDir < 0 ? " v" : " ^") + "</span>"
        : "";
    return (
      '<th scope="col"><button type="button" data-sort="' +
      key +
      '">' +
      esc(label) +
      marker +
      "</button></th>"
    );
  }

  function boardRowHtml(row, maxImplied) {
    var growth =
      row.change_7d === null ? "n/a" : fmtChange(row.change_7d);
    var growthClass =
      row.change_7d === null ? "" : row.change_7d >= 0 ? " pos" : " neg";
    var width = Math.max(
      3,
      Math.round((row.implied_value_usd / maxImplied) * 100)
    );
    var sub =
      esc(row.category || "Other") +
      " on " +
      esc(fmtChains(row)) +
      (watchlist[row.slug] ? " · watchlist" : "");
    return (
      '<tr data-open="' +
      esc(row.slug) +
      '" data-selected="' +
      (view.selected === row.slug ? "true" : "false") +
      '" tabindex="0">' +
      '<td class="num">' +
      row.rank +
      "</td>" +
      '<td><div class="name"><b>' +
      esc(row.name) +
      '</b><span class="sub">' +
      sub +
      "</span></div></td>" +
      '<td class="num">' +
      fmtMoney(row.tvl_usd) +
      "</td>" +
      '<td class="num' +
      growthClass +
      '">' +
      growth +
      "</td>" +
      '<td class="num">' +
      fmtAge(row.age_days) +
      "</td>" +
      '<td class="num">' +
      fmtMultiple(row.implied_value_usd / row.tvl_usd) +
      "</td>" +
      '<td><div class="implied"><div class="bar" aria-hidden="true"><i style="width:' +
      width +
      '%"></i></div><span class="num">' +
      fmtMoney(row.implied_value_usd) +
      "</span></div></td>" +
      '<td><span class="status">no token</span></td>' +
      "</tr>"
    );
  }

  function boardHtml() {
    var list = sortRows(applyFilters());
    if (list.length === 0) {
      return (
        '<div class="panel"><div class="empty">' +
        "<h2>No protocol matches that filter</h2>" +
        "<p>Clear the search or pick another category to see the board again.</p>" +
        '<button class="button primary" type="button" data-clear="1">Clear filters</button>' +
        "</div></div>"
      );
    }
    var maxImplied = list[0].implied_value_usd || 1;
    return (
      '<div class="panel"><div class="table-wrap"><table>' +
      '<caption class="sub">Pre-token protocols, strongest implied value first. ' +
      "Select a row for its model and farm plan.</caption>" +
      "<thead><tr>" +
      sortButtonHtml("implied", "Rank") +
      sortButtonHtml("name", "Protocol") +
      sortButtonHtml("tvl", "TVL") +
      sortButtonHtml("growth", "7d") +
      sortButtonHtml("age", "Age") +
      sortButtonHtml("multiple", "Multiple") +
      sortButtonHtml("implied", "Implied value") +
      '<th scope="col">Token</th>' +
      "</tr></thead><tbody>" +
      list.map(function (row) {
        return boardRowHtml(row, maxImplied);
      }).join("") +
      "</tbody></table></div></div>"
    );
  }

  function liveHtml() {
    var rows = RADAR.live.map(function (row) {
      var growthClass =
        row.change_7d !== null && row.change_7d >= 0 ? " pos" : " neg";
      return (
        "<tr>" +
        '<td class="num">live</td>' +
        '<td><div class="name"><b>' +
        esc(row.name) +
        '</b><span class="sub">' +
        esc(row.category || "Other") +
        " on " +
        esc(fmtChains(row)) +
        "</span></div></td>" +
        '<td class="num">' +
        fmtMoney(row.tvl_usd) +
        "</td>" +
        '<td class="num' +
        growthClass +
        '">' +
        fmtChange(row.change_7d) +
        "</td>" +
        '<td class="num">' +
        fmtMoney(row.mcap_usd) +
        "</td>" +
        '<td><span class="status">already trades</span></td>' +
        "</tr>"
      );
    });
    return (
      '<div class="panel"><div class="table-wrap"><table>' +
      '<caption class="sub">Token live: these protocols already trade, so their market cap is a fact, ' +
      "not a model. They are set aside from the pre-token ranking.</caption>" +
      "<thead><tr>" +
      '<th scope="col">Status</th><th scope="col">Protocol</th>' +
      '<th scope="col">TVL</th><th scope="col">7d</th>' +
      '<th scope="col">Market cap</th><th scope="col">Token</th>' +
      "</tr></thead><tbody>" +
      rows.join("") +
      "</tbody></table></div></div>"
    );
  }

  function modelHtml() {
    var m = RADAR.model;
    var formula =
      "implied = round( tvl_usd x " +
      m.base_multiple +
      " x growth x maturity x breadth x size ), where growth = 1 + clamp(change_7d, " +
      m.growth_floor +
      ", " +
      m.growth_cap +
      ") / 100, maturity = " +
      m.maturity_floor +
      " + " +
      m.maturity_range +
      " x sqrt(min(age_days, " +
      m.maturity_days +
      ") / " +
      m.maturity_days +
      "), breadth = 1 + " +
      m.breadth_per_chain +
      " x min(chains - 1, " +
      m.breadth_max_chains +
      "), size = clamp((1e9 / tvl_usd) ^ " +
      m.size_exponent +
      ", " +
      m.size_floor +
      ", " +
      m.size_cap +
      ")";
    return (
      '<section class="panel model">' +
      "<h2>How implied value is computed</h2>" +
      "<p class=\"sub\">Every row is scored by one function of the snapshot figures. No protocol name is " +
      "special-cased, and no row is hand-picked. Wrapped, staked and bridged products are excluded by the " +
      "watchlist’s own rule, so none of them is ever presented as a token that does not exist yet.</p>" +
      '<div class="formula">' +
      esc(formula) +
      "</div>" +
      '<table class="factor-table"><tbody>' +
      "<tr><td>Growth: a week’s spike, however large, at most doubles the multiple</td><td>0.50 – 2.00x</td></tr>" +
      "<tr><td>Maturity: longer with no token, more pent-up value, with diminishing returns</td><td>0.65 – 1.00x</td></tr>" +
      "<tr><td>Breadth: each extra chain adds 4%, up to four</td><td>1.00 – 1.16x</td></tr>" +
      "<tr><td>Size: a diminishing multiple, so giants do not win on size alone</td><td>0.75 – 1.25x</td></tr>" +
      "<tr><td>Age unknown: the model uses " +
      m.unknown_age_days +
      " days</td><td>0.82x maturity</td></tr>" +
      "</tbody></table>" +
      "<p class=\"sub\">TVL and seven-day growth come from the snapshot. Age is the time since the protocol was " +
      "first listed, the best record of how long it has run with no token. The early radar is every other launch " +
      "candidate below the watchlist floor, and the live-token protocols are set aside with their market caps shown. " +
      "This is an estimate, not a price.</p>" +
      "</section>"
    );
  }

  // --- the detail view ------------------------------------------------------
  var dialog = document.createElement("dialog");
  dialog.className = "detail";
  dialog.id = "detail";
  dialog.setAttribute("aria-labelledby", "detail-title");
  dialog.addEventListener("close", function () {
    view.selected = null;
    saveHash();
  });

  function equationRow(label, value) {
    return (
      "<div><span>" +
      esc(label) +
      '</span><b class="num">' +
      esc(value) +
      "</b></div>"
    );
  }

  function showDetail(slug) {
    var row = null;
    for (var i = 0; i < RADAR.rows.length; i++) {
      if (RADAR.rows[i].slug === slug) {
        row = RADAR.rows[i];
        break;
      }
    }
    if (!row) return;
    view.selected = slug;
    saveHash();

    var parts = scoreParts(row, RADAR.model);
    var recomputed = scoreRow(row, RADAR.model);
    var steps = planSteps(row);
    var flags = rowFlags(row);
    var chainList = (row.chains || []).join(", ") || "an unnamed chain";
    var tag = watchlist[row.slug] ? " · watchlist" : " · early radar";
    var checkNote =
      recomputed === row.implied_value_usd
        ? ", the same number board.json carries."
        : ", which differs from the board: the data would be stale.";

    var html =
      '<div class="detail-head"><div>' +
      '<span class="brand-name">Rank ' +
      row.rank +
      " of " +
      RADAR.board_size +
      tag +
      "</span>" +
      '<h2 id="detail-title">' +
      esc(row.name) +
      "</h2>" +
      '<p class="sub">' +
      esc(row.category || "Other") +
      " on " +
      esc(chainList) +
      " · records no token</p></div>" +
      '<button class="close" type="button" aria-label="Close details" data-close="1">Close</button></div>';

    if (flags.length) {
      html +=
        '<div class="flags">' +
        flags
          .map(function (text) {
            return '<span class="flag">' + esc(text) + "</span>";
          })
          .join("") +
        "</div>";
    }

    html +=
      '<section class="detail-section"><h3>Implied value</h3>' +
      '<div class="equation">' +
      equationRow("TVL", fmtMoney(row.tvl_usd)) +
      equationRow("Seven-day growth", fmtChange(row.change_7d)) +
      equationRow("Age with no token", fmtAge(row.age_days)) +
      equationRow("Chains", String((row.chains || []).length)) +
      equationRow("Growth multiplier", parts.growthMult.toFixed(4)) +
      equationRow("Maturity multiplier", parts.maturity.toFixed(4)) +
      equationRow("Breadth multiplier", parts.breadth.toFixed(4)) +
      equationRow("Size multiplier", parts.size.toFixed(4)) +
      equationRow("Implied value", fmtMoney(row.implied_value_usd)) +
      equationRow(
        "Multiple on TVL",
        fmtMultiple(row.implied_value_usd / row.tvl_usd)
      ) +
      "</div>" +
      '<p class="sub">Model ' +
      esc(RADAR.model_version) +
      ": the same function scores every protocol. The page recomputes this row as " +
      fmtMoney(recomputed) +
      checkNote +
      " This is an estimate, not a price.</p></section>";

    html +=
      '<section class="detail-section"><h3>Farm plan</h3><ol class="steps">' +
      steps
        .map(function (step) {
          return (
            "<li><b>" +
            esc(step.action) +
            '</b><span class="cost">' +
            esc(step.meta) +
            "</span></li>"
          );
        })
        .join("") +
      "</ol></section>";

    dialog.innerHTML = html;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  function closeDetail() {
    if (dialog.open) dialog.close();
  }

  // --- page assembly and events ---------------------------------------------
  function renderPage() {
    var shown = applyFilters().length;
    var shell =
      '<div class="shell">' +
      headerHtml() +
      introHtml() +
      topThreeHtml() +
      filtersHtml(shown) +
      (view.tab === "pre-token" ? boardHtml() : liveHtml()) +
      (view.tab === "pre-token" ? modelHtml() : "") +
      "</div>";
    mount.innerHTML = shell;
    mount.setAttribute("aria-busy", "false");
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) showDetail(view.selected);
  }

  function clearFilters() {
    view.query = "";
    view.category = "all";
    view.chain = "all";
    view.minTvl = 0;
    view.watchlistOnly = false;
    saveHash();
    renderPage();
  }

  mount.addEventListener("click", function (event) {
    var target = event.target;
    var opener = target.closest ? target.closest("[data-open]") : null;
    if (opener) {
      showDetail(opener.getAttribute("data-open"));
      return;
    }
    var tab = target.closest ? target.closest("[data-tab]") : null;
    if (tab) {
      view.tab = tab.getAttribute("data-tab");
      renderPage();
      return;
    }
    var sorter = target.closest ? target.closest("[data-sort]") : null;
    if (sorter) {
      var key = sorter.getAttribute("data-sort");
      if (view.sortKey === key) {
        view.sortDir = -view.sortDir;
      } else {
        view.sortKey = key;
        view.sortDir = -1;
      }
      renderPage();
      return;
    }
    var clearer = target.closest ? target.closest("[data-clear]") : null;
    if (clearer) {
      clearFilters();
      return;
    }
    var closer = target.closest ? target.closest("[data-close]") : null;
    if (closer) closeDetail();
  });

  mount.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var target = event.target;
    var opener = target.closest ? target.closest("[data-open]") : null;
    if (opener && target.tagName !== "BUTTON") {
      event.preventDefault();
      showDetail(opener.getAttribute("data-open"));
    }
  });

  mount.addEventListener("input", function (event) {
    if (event.target.id === "q") {
      view.query = event.target.value;
      saveHash();
      renderPage();
      var search = document.getElementById("q");
      if (search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    }
  });

  mount.addEventListener("change", function (event) {
    var target = event.target;
    if (target.id === "category") {
      view.category = target.value;
      saveHash();
      renderPage();
    } else if (target.id === "chain") {
      view.chain = target.value;
      saveHash();
      renderPage();
    } else if (target.id === "mintvl") {
      view.minTvl = Number(target.value);
      renderPage();
    } else if (target.id === "watchlist-only") {
      view.watchlistOnly = target.checked;
      renderPage();
    }
  });

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && dialog.open) dialog.close();
  });

  readHash();
  renderPage();
})();
