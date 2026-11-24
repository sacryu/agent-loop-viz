// 演示站的剧本：一个星系群里的几个星系，每个星系里有几段编好的对话。全是编的，没有任何真实的路径、名字、项目。
// 由 tools/demo/build.mjs 展开成事件（和插件在本机模式下发的完全同一种格式），写进 web/src/demo/script.json。
//
// 星系没有名字：页面每次打开时给每个星系一个随机编号，名字是由编号生成的星表编号（和没设名字的真实星系一样，见 web/src/play.ts）。
// 项目和对话是别人对这个项目的第一印象，值得按自己的想法改（改完运行 npm run demo:script）。
//
// 写法：
//   星系 { sessions: [对话…] }
//   对话 { proj: 项目目录, title: Claude Code 给这段对话起的标题, model, start: 开场后第几秒出现, gap: 一轮轮之间你想下一句话的秒数, rounds: [轮…] }
//   轮   { prompt: 你说的话, laps: [圈…], answer: 回答（最后一句会显示出来）, bg?: 回答完还在后台跑的秒数 }
//   圈   [工具, 工具…]（同一圈里并行跑的几个工具） 或 { agent: 类型, desc: 说明, steps: [工具…] }（派一个子 agent）
//   工具 [名字, 输入, 秒数, 输出?, { fail?: 报错, ask?: 等你授权的秒数 }?]

const R = "/home/dev";   // 所有项目都放在这个假目录下

const read = (p, content, s = 0.3) => ["Read", { file_path: p }, s, { type: "text", file: { filePath: p, content } }];
const edit = (p, o, n, s = 0.4) => ["Edit", { file_path: p, old_string: o, new_string: n }, s,
  { filePath: p, oldString: o, newString: n, structuredPatch: [{ oldStart: 12, newStart: 12, lines: o.split("\n").map(l => "-" + l).concat(n.split("\n").map(l => "+" + l)) }] }];
const bash = (command, s, stdout = "", opts) => ["Bash", { command, description: "" }, s, { stdout, stderr: "", interrupted: false }, opts];
const grep = (pattern, s = 0.4, content = "") => ["Grep", { pattern, path: "src", output_mode: "content" }, s, { mode: "content", content, numFiles: 2 }];
const glob = (pattern, files, s = 0.2) => ["Glob", { pattern }, s, { filenames: files, numFiles: files.length }];
const fetchUrl = (url, s = 1.6) => ["WebFetch", { url, prompt: "Summarize the relevant part" }, s, "…"];
const search = (query, s = 2.2) => ["WebSearch", { query }, s, { query, results: [] }];
const write = (p, content, s = 0.3) => ["Write", { file_path: p, content }, s, { type: "create", filePath: p, content }];
const todo = () => ["TodoWrite", { todos: [] }, 0.05, { ok: true }];

export const GALAXIES = [
  {
    sessions: [
      {
        proj: `${R}/tide-tables`, title: "DST tide time offset", model: "claude-opus-5-5", start: 0, gap: 14,
        rounds: [
          {
            prompt: "The high-tide times are off by an hour after the DST switch. Find out why and fix it.",
            laps: [
              [grep("toLocalTime", 0.5, "src/tides.ts:41:  return toLocalTime(t, station.tz)\nsrc/time.ts:8:export function toLocalTime(")],
              [read(`${R}/tide-tables/src/time.ts`, "export function toLocalTime(t: number, tz: string) {\n  const offset = OFFSETS[tz];\n  return new Date(t + offset);\n}\n"),
                read(`${R}/tide-tables/src/tides.ts`, "…")],
              [bash("npm test -- time", 4.2, "", { fail: "FAIL test/time.test.ts\n  ● toLocalTime › handles the March DST switch\n    expected 05:12, received 04:12" })],
              [edit(`${R}/tide-tables/src/time.ts`, "  const offset = OFFSETS[tz];\n  return new Date(t + offset);", "  return zonedTime(t, tz);   // uses the tz database, so DST is handled")],
              [bash("npm test", 6.5, "PASS test/time.test.ts\nPASS test/tides.test.ts\nTests: 48 passed")],
            ],
            answer: "The offsets were a fixed table, so they ignored DST. It now uses the tz database, and the new test covers the March switch.",
          },
          {
            prompt: "Add a weekly view that shows the two highest tides each day",
            laps: [
              [glob("src/views/*.tsx", ["src/views/Day.tsx", "src/views/Month.tsx"])],
              [read(`${R}/tide-tables/src/views/Month.tsx`, "export function Month({ tides }) { … }")],
              [write(`${R}/tide-tables/src/views/Week.tsx`, "export function Week({ tides }) {\n  const days = groupByDay(tides);\n  …\n}\n", 0.4)],
              [edit(`${R}/tide-tables/src/App.tsx`, "<Month tides={tides} />", "{view === \"week\" ? <Week tides={tides} /> : <Month tides={tides} />}")],
              [bash("npm run build", 9, "built in 8.7s")],
            ],
            answer: "Added a Week view with the two highest tides per day, and a toggle next to the month picker.",
          },
        ],
      },
      {
        proj: `${R}/tide-tables`, title: "Release notes for 2.4", model: "claude-opus-5-5", start: 22, gap: 30,
        rounds: [
          {
            prompt: "Write the release notes for 2.4 from the merged PRs",
            laps: [
              [bash("git log v2.3..HEAD --oneline", 0.6, "a1f2c3d Fix DST offsets\n9e8d7c6 Week view\n…")],
              [{ agent: "Explore", desc: "Summarize each merged PR in one line", steps: [
                bash("gh pr list --state merged --limit 20", 2.4, "#88 Fix DST offsets\n#87 Week view\n#85 Station search"),
                read(`${R}/tide-tables/CHANGELOG.md`, "## 2.3\n- Station search\n"),
                grep("BREAKING", 0.4, ""),
              ] }],
              [edit(`${R}/tide-tables/CHANGELOG.md`, "## 2.3", "## 2.4\n- Tide times are right across DST switches\n- New week view\n\n## 2.3")],
            ],
            answer: "Release notes for 2.4 are at the top of CHANGELOG.md.",
          },
        ],
      },
    ],
  },
  {
    sessions: [
      {
        proj: `${R}/pocket-ledger`, title: "Bank CSV import crash", model: "claude-sonnet-5-5", start: 3, gap: 18,
        rounds: [
          {
            prompt: "Importing the bank CSV crashes on rows with a comma in the payee",
            laps: [
              [read(`${R}/pocket-ledger/src/import/csv.ts`, "export function parse(text) {\n  return text.split(\"\\n\").map(l => l.split(\",\"));\n}\n")],
              [search("RFC 4180 quoted fields CSV parsing"), fetchUrl("https://www.rfc-editor.org/rfc/rfc4180")],
              [edit(`${R}/pocket-ledger/src/import/csv.ts`, "  return text.split(\"\\n\").map(l => l.split(\",\"));", "  return parseRfc4180(text);")],
              [write(`${R}/pocket-ledger/test/csv.test.ts`, "test(\"quoted payee with a comma\", …)")],
              [bash("npm test -- csv", 3.1, "PASS test/csv.test.ts\nTests: 9 passed")],
            ],
            answer: "Rows are parsed per RFC 4180 now, so quoted fields with commas work. Added a test with the failing row.",
          },
          {
            prompt: "Can you also show a monthly total per category?",
            laps: [
              [grep("categor", 0.5, "src/model.ts:14:  category: string\nsrc/views/List.tsx:30:  {t.category}")],
              [read(`${R}/pocket-ledger/src/views/List.tsx`, "…")],
              [write(`${R}/pocket-ledger/src/views/Totals.tsx`, "export function Totals({ rows }) { … }")],
              [edit(`${R}/pocket-ledger/src/App.tsx`, "<List rows={rows} />", "<List rows={rows} />\n<Totals rows={rows} />", 0.3)],
              [bash("npm run lint", 2.2, "", { ask: 7 })],
              [bash("npm test", 5.2, "Tests: 61 passed")],
            ],
            answer: "Monthly totals per category now appear under the list.",
          },
        ],
      },
      {
        proj: `${R}/trail-map`, title: "Rename elevation helper", model: "claude-haiku-5-5", start: 9, gap: 40,
        rounds: [
          {
            prompt: "Rename the elevation helper to something clearer",
            laps: [
              [grep("elev\\(", 0.3, "src/geo.ts:3:export const elev = …\nsrc/profile.ts:19:  elev(p)")],
              [edit(`${R}/trail-map/src/geo.ts`, "export const elev =", "export const elevationAt =", 0.2), edit(`${R}/trail-map/src/profile.ts`, "elev(p)", "elevationAt(p)", 0.2)],
              [bash("npx tsc --noEmit", 3.4, "")],
            ],
            answer: "Renamed elev to elevationAt in both places; the types check.",
          },
        ],
      },
    ],
  },
  {
    sessions: [
      {
        proj: `${R}/recipe-box`, title: "Recipe scaling by servings", model: "claude-opus-5-5", start: 1, gap: 20,
        rounds: [
          {
            prompt: "Scale recipes by servings, and keep the fractions readable",
            laps: [
              [todo()],
              [read(`${R}/recipe-box/src/recipe.ts`, "export interface Ingredient { qty: number; unit: string; name: string }")],
              [{ agent: "general-purpose", desc: "Find a small fraction-formatting approach", steps: [
                search("format decimal as kitchen fraction 1/3 2/3"),
                read(`${R}/recipe-box/src/format.ts`, "export const fmt = (n) => n.toFixed(2)"),
              ] }],
              [write(`${R}/recipe-box/src/scale.ts`, "export function scale(r, servings) { … }"), edit(`${R}/recipe-box/src/format.ts`, "n.toFixed(2)", "toFraction(n)")],
              [bash("npm test", 4.8, "Tests: 33 passed")],
              [todo()],
            ],
            answer: "Recipes scale by servings, and quantities print as kitchen fractions like 1 ⅓ cups.",
          },
          {
            prompt: "Deploy the preview",
            laps: [
              [bash("npm run build", 7.2, "built in 7.0s")],
              [bash("npx wrangler pages deploy dist --branch preview", 11, "", { fail: "✘ Authentication error [code: 10000]: token expired", ask: 5 })],
            ],
            answer: "The deploy failed: the Cloudflare token has expired. Run `npx wrangler login` and I'll try again.",
          },
        ],
      },
    ],
  },
  {
    sessions: [
      {
        proj: `${R}/weather-cli`, title: "weather-cli 加 --json 输出", model: "claude-sonnet-5-5", start: 5, gap: 16,
        rounds: [
          {
            prompt: "加一个 --json 参数，输出机器能读的结果",
            laps: [
              [read(`${R}/weather-cli/src/main.rs`, "fn main() {\n    let args = Args::parse();\n    …\n}")],
              [edit(`${R}/weather-cli/src/main.rs`, "    #[arg(long)]\n    units: Units,", "    #[arg(long)]\n    units: Units,\n    #[arg(long)]\n    json: bool,")],
              [edit(`${R}/weather-cli/src/print.rs`, "pub fn print(f: &Forecast) {", "pub fn print(f: &Forecast, json: bool) {\n    if json { return println!(\"{}\", serde_json::to_string(f).unwrap()); }")],
              [bash("cargo build", 12, "   Compiling weather-cli v0.3.0\n    Finished dev [unoptimized] target(s)")],
              [bash("cargo run -- --city Lisbon --json", 1.4, "{\"city\":\"Lisbon\",\"temp_c\":19.5}")],
            ],
            answer: "加好了：--json 会输出一行 JSON，原来的格式不变。",
          },
          {
            prompt: "顺便把测试补上",
            laps: [
              [glob("tests/*.rs", ["tests/cli.rs"])],
              [read(`${R}/weather-cli/tests/cli.rs`, "#[test]\nfn prints_city() { … }")],
              [edit(`${R}/weather-cli/tests/cli.rs`, "fn prints_city() { … }", "fn prints_city() { … }\n\n#[test]\nfn json_output_parses() { … }")],
              [bash("cargo test", 14, "test result: ok. 7 passed; 0 failed")],
            ],
            answer: "补了一个 JSON 输出的测试，7 个测试都过了。",
            bg: 9,
          },
        ],
      },
    ],
  },
  {
    sessions: [
      {
        proj: `${R}/pixel-garden`, title: "Plants wilt without water", model: "claude-fable-5-2", start: 2, gap: 12,
        rounds: [
          {
            prompt: "Plants should wilt if nobody waters them for three in-game days",
            laps: [
              [grep("water", 0.4, "src/plant.ts:22:  water() { this.lastWatered = world.day }")],
              [read(`${R}/pixel-garden/src/plant.ts`, "export class Plant { … }"), read(`${R}/pixel-garden/src/world.ts`, "export const world = { day: 0 }")],
              [edit(`${R}/pixel-garden/src/plant.ts`, "  tick() {", "  tick() {\n    if (world.day - this.lastWatered >= 3) this.state = \"wilted\";")],
              [edit(`${R}/pixel-garden/src/sprites.ts`, "  grown: 4,", "  grown: 4,\n  wilted: 5,")],
              [bash("npm run dev -- --check", 3.8, "ok")],
            ],
            answer: "Plants wilt after three days without water and recover when watered.",
          },
        ],
      },
      {
        proj: `${R}/pixel-garden`, title: "Save-file format review", model: "claude-fable-5-2", start: 16, gap: 22,
        rounds: [
          {
            prompt: "Review the save-file format before we ship it",
            laps: [
              [{ agent: "code-reviewer", desc: "Review src/save.ts for forward compatibility", steps: [
                read(`${R}/pixel-garden/src/save.ts`, "export function save(world) { return JSON.stringify(world) }"),
                grep("version", 0.3, ""),
                read(`${R}/pixel-garden/src/load.ts`, "export function load(s) { return JSON.parse(s) }"),
              ] }],
              [edit(`${R}/pixel-garden/src/save.ts`, "return JSON.stringify(world)", "return JSON.stringify({ version: 1, world })")],
            ],
            answer: "The format had no version field, so old saves couldn't be migrated. It's versioned now.",
          },
        ],
      },
    ],
  },
  {
    sessions: [
      {
        proj: `${R}/static-site`, title: "Dark mode flash on load", model: "claude-sonnet-5-5", start: 6, gap: 25,
        rounds: [
          {
            prompt: "The dark mode toggle flashes white on page load",
            laps: [
              [read(`${R}/static-site/layouts/base.html`, "<html>\n<head>…</head>")],
              [search("prevent flash of light theme before hydration")],
              [edit(`${R}/static-site/layouts/base.html`, "<head>", "<head>\n<script>document.documentElement.dataset.theme = localStorage.theme || \"dark\"</script>")],
              [bash("npm run build && npx serve dist", 4, "Serving dist on :3000", { ask: 6 })],
            ],
            answer: "The theme is set before the first paint now, so there's no white flash.",
          },
        ],
      },
    ],
  },
];
