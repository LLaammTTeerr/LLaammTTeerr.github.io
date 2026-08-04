/**
 * The demo corpus, and the manifest that lets it be removed exactly.
 *
 * Seeding is not "write some files and build". §3.6 places a transaction in the
 * month it *enters* the chain, not the date it claims, so writing every post up
 * front and building once would clamp all of them into one fat open block. The
 * seeder therefore interleaves: write the month's posts, run `chain:build` with
 * that month's clock, repeat. That is also what produces a size-split month, a
 * silent month, and a real amendment — none of which a single build can make.
 *
 * Every path this module names is removed by `npm run demo:clear`, which then
 * rebuilds the chain from whatever is left. Nothing else knows these files
 * exist, so the demo cannot leak into the site's own logic.
 */

export interface DemoPost {
  /** Written to `content/posts/<slug>.md`. */
  slug: string;
  title: string;
  date: string;
  tags: string[];
  series?: string;
  /** Omitted on purpose for some posts, so the `—` em dash renders (§3.8). */
  research?: number;
  body: string;
}

/** A month's worth of authoring, followed by the build that seals it. */
export interface DemoRound {
  /** Injected clock for the `chain:build` that follows these writes. */
  now: string;
  posts: DemoPost[];
  /** Applied before the build: an edit to an already-sealed post (§3.9). */
  amend?: { slug: string; title?: string; research?: number; appendBody?: string };
  note: string;
}

const p = (
  slug: string,
  title: string,
  date: string,
  tags: string[],
  research: number | undefined,
  body: string,
  series?: string,
): DemoPost => ({ slug, title, date, tags, research, body, series });

const LOREM_CP = `
Bài toán yêu cầu trả lời nhiều truy vấn trên một mảng tĩnh, và giới hạn khiến
cách làm ngây thơ không kịp. Ý tưởng ở đây là chia mảng thành các khối có kích
thước xấp xỉ căn bậc hai của độ dài, rồi tiền xử lý từng khối.

Điểm dễ sai là biên: khi truy vấn nằm gọn trong một khối, ta phải xử lý riêng
thay vì đi qua vòng lặp chung. Tôi đã mất khá nhiều lần nộp bài mới nhận ra.

Độ phức tạp cuối cùng vào khoảng \`O((n + q) * sqrt(n))\`, đủ cho giới hạn đề bài.
`.trim();

const LOREM_SW = `
Phần khó nhất không phải là viết code, mà là quyết định cái gì thuộc về đâu.
Khi một tệp bắt đầu làm hai việc, mọi thay đổi sau đó đều phải đọc cả hai.

Tôi tách theo trách nhiệm chứ không theo tầng kỹ thuật: những thứ thay đổi cùng
nhau thì nằm cùng nhau. Cách này khiến số tệp nhiều hơn nhưng mỗi tệp đọc được
trong một lần.
`.trim();

const LOREM_ESSAY = `
Có một khoảng cách giữa việc hiểu một ý tưởng và việc dùng được nó. Tôi thường
nhầm hai điều đó với nhau, rồi ngạc nhiên khi ngồi trước trang giấy trắng.

Viết ra là cách tôi kiểm tra mình có thực sự hiểu hay không. Nếu không diễn đạt
được thành câu, gần như chắc chắn là chưa hiểu.
`.trim();


const LOREM_LONG = `
Bài này dài hơn hẳn các bài khác trong bộ mẫu, và có chủ đích: thanh tiến độ đọc
chỉ hiện khi bài cao hơn màn hình, còn khối mã và công thức thì cần một chỗ thật
để xem chúng cư xử ra sao bên trong thẻ bài viết.

## Bài toán

Cho một mảng \`a\` gồm \`n\` phần tử và \`q\` truy vấn, mỗi truy vấn hỏi tổng của một
đoạn con. Cách ngây thơ mất \`O(nq)\`, quá chậm khi cả hai đều tới \`10^5\`.

Gọi $S_i$ là tổng tiền tố tới vị trí $i$. Khi đó tổng đoạn $[l, r]$ chính là
$S_r - S_{l-1}$, và mỗi truy vấn trở thành một phép trừ.

$$
S_i = \\sum_{k=1}^{i} a_k \\qquad \\text{tong}(l, r) = S_r - S_{l-1}
$$

## Cài đặt

Phần khó không nằm ở ý tưởng mà ở chỉ số. Tôi luôn để \`S\` lệch một, tức
\`S[0] = 0\`, để không phải viết trường hợp riêng cho \`l = 1\`:

\`\`\`cpp
#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n, q;
    cin >> n >> q;

    vector<long long> S(n + 1, 0);
    for (int i = 1; i <= n; ++i) {
        long long x;
        cin >> x;
        S[i] = S[i - 1] + x;      // tien to lech mot
    }

    while (q--) {
        int l, r;
        cin >> l >> r;
        cout << S[r] - S[l - 1] << '\\n';
    }
    return 0;
}
\`\`\`

Kiểu \`long long\` không phải để cho chắc: với \`n = 10^5\` phần tử mỗi phần tử tới
\`10^9\`, tổng đã vượt \`int\` từ lâu. Đây là lỗi tôi mắc nhiều lần nhất.

## Khi mảng thay đổi

Tiền tố chỉ đúng với mảng tĩnh. Cập nhật một phần tử làm hỏng mọi \`S_i\` phía sau,
nên chi phí cập nhật là $O(n)$. Lúc đó mới cần tới Fenwick hoặc segment tree, và
đánh đổi trở thành:

| Cấu trúc | Truy vấn | Cập nhật |
|---|---|---|
| Tiền tố | $O(1)$ | $O(n)$ |
| Fenwick | $O(\\log n)$ | $O(\\log n)$ |
| Segment tree | $O(\\log n)$ | $O(\\log n)$ |

Nếu đề chỉ hỏi mà không sửa, đừng viết segment tree. Tôi đã mất khá nhiều thời
gian cho những cây không ai đụng tới.

## Một lưu ý cuối

Đọc vào bằng \`cin\` không tắt đồng bộ thì \`10^5\` truy vấn cũng đủ chậm để trượt
giới hạn. Hai dòng \`sync_with_stdio\` và \`tie\` ở đầu \`main\` không phải mê tín.
`.trim();

const LOREM_CHAIN = `
Một chuỗi khối không có gì huyền bí: nó là danh sách liên kết mà mỗi nút mang
băm của nút trước. Tính bất biến đến từ chỗ đó, không đến từ thuật toán đồng
thuận hay từ tiền mã hoá.

Điều thú vị là khi bỏ hết phần tiền tệ đi, cấu trúc còn lại vẫn hữu ích cho bất
kỳ thứ gì cần lịch sử chống sửa đổi — kể cả một cái blog.
`.trim();

/**
 * Two diagrams, referenced by posts so they mint as tokens (§3.2b).
 *
 * They carry no baked page colour. An `<img>`-embedded SVG is an isolated
 * document — it cannot inherit `currentColor` from the host page — so each one
 * ships its own `prefers-color-scheme` rule and a transparent background. The
 * first attempt filled the background with `#0d1117`, which is exactly the
 * default palette's page colour: on that theme the image vanished into the page
 * and on the two light themes it was a dark slab.
 */
const diagram = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  '<style>' +
  ':root{--ink:#57606a;--line:#d0d7de}' +
  '@media (prefers-color-scheme:dark){:root{--ink:#8b949e;--line:#30363d}}' +
  '.s{fill:none;stroke:var(--ink);stroke-width:2}' +
  '.f{fill:none;stroke:var(--line);stroke-width:1}' +
  '.t{fill:var(--ink);font-family:ui-monospace,monospace;font-size:11px}' +
  '</style>' +
  body +
  '</svg>';

export const DEMO_ASSETS: { file: string; svg: string }[] = [
  {
    file: 'so-do-sqrt.svg',
    svg: diagram(
      320,
      96,
      `<rect class="f" x="1" y="1" width="318" height="94" rx="4"/>` +
        [0, 1, 2, 3]
          .map((i) => `<rect class="s" x="${16 + i * 74}" y="20" width="62" height="40" rx="3"/>`)
          .join('') +
        '<text class="t" x="160" y="82" text-anchor="middle">sqrt decomposition</text>',
    ),
  },
  {
    file: 'so-do-merkle.svg',
    svg: diagram(
      320,
      148,
      `<rect class="f" x="1" y="1" width="318" height="146" rx="4"/>` +
        '<g class="s"><circle cx="160" cy="28" r="11"/><circle cx="96" cy="80" r="11"/>' +
        '<circle cx="224" cy="80" r="11"/><circle cx="64" cy="124" r="9"/>' +
        '<circle cx="128" cy="124" r="9"/><circle cx="192" cy="124" r="9"/>' +
        '<circle cx="256" cy="124" r="9"/>' +
        '<path d="M152 36 106 70M168 36 214 70M89 89 71 114M103 89 121 114M217 89 199 114M231 89 249 114"/></g>' +
        '<text class="t" x="160" y="16" text-anchor="middle">merkle root</text>',
    ),
  },
];

/** Drafts — deliberately never on the chain (§3.6, §5.1). */
export const DEMO_DRAFTS: { slug: string; title: string; date: string }[] = [
  { slug: 'wip-cay-phan-doan', title: 'Cây phân đoạn với lazy propagation', date: '2026-08-01' },
  { slug: 'wip-trinh-bien-dich', title: 'Viết một trình biên dịch nhỏ bằng Rust', date: '2026-07-28' },
  { slug: 'wip-doc-sach', title: 'Ghi chú đọc sách quý này', date: '2026-08-02' },
];

/** A project, written to `content/contracts/<slug>.md`. */
export interface DemoContract {
  slug: string;
  name: string;
  summary: string;
  /**
   * Omitted on purpose for one of them (§6): a contract that declares no repo
   * must render no link rather than a dead one, and the preview is where that
   * is actually looked at.
   */
  repo?: string;
  language: string;
  body: string;
}

/**
 * Projects — read at build time, hashed nowhere (§5.1), like the drafts above.
 *
 * The repo urls are on the reserved `.example` TLD, the same placeholder
 * convention `astro.config.mjs` uses for `site`. `content/profile.md` makes the
 * point in its own way: it ships three link labels and no url at all, because a
 * url that looks real and is not points a reader at somebody else's repository.
 * One of the two here therefore declares no repo, so both renderings — a linked
 * source and an absent one — are visible in the preview.
 */
export const DEMO_CONTRACTS: DemoContract[] = [
  {
    slug: 'blogchain',
    name: 'Blogchain',
    summary: 'Chính trang này: một blog tĩnh dựng như trình duyệt blockchain.',
    repo: 'https://github.example/lamter/blogchain',
    language: 'TypeScript',
    body: `
Mỗi bài viết là một giao dịch, mỗi tháng là một khối, mỗi thẻ là một địa chỉ.
Hash là SHA-256 thật, cây Merkle là cây Merkle thật, và proof of work được đào
thật ở lúc build — không có gì mô phỏng.

Phần khó nhất không phải là mật mã mà là kỷ luật: mỗi con số hiện trên trang
phải hoặc nằm trong sổ, hoặc tính lại được từ thứ nằm trong sổ. Chỗ nào không
thoả thì để dấu gạch ngang, chứ không đoán.

Bản thân trang này thì **chưa lên chuỗi** — nó là mã nguồn, không phải bài viết.
    `.trim(),
  },
  {
    slug: 'cf-mcp',
    name: 'Máy chủ MCP cho Codeforces',
    summary: 'Công cụ đọc đề và nộp bài Codeforces, chưa công bố mã nguồn.',
    language: 'Rust',
    body: `
Một máy chủ MCP nhỏ để lấy đề, xem bảng xếp hạng và nộp bài mà không rời khỏi
trình soạn thảo. Phần thú vị là chuẩn hoá đề bài về một dạng duy nhất, vì mỗi
kỳ thi lại đánh dấu phần giới hạn một kiểu khác nhau.

Mục này cố tình chưa khai báo kho mã: khi chưa có địa chỉ thật thì trang không
dựng liên kết nào cả, thay vì trỏ tới một nơi không tồn tại.
    `.trim(),
  },
];

export const DEMO_ROUNDS: DemoRound[] = [
  {
    now: '2026-03-28',
    note: 'Tháng đầu: hai bài, khối niêm phong theo quy tắc cuối tháng.',
    posts: [
      p('2026-03-04-mo-algorithm', "Mo's algorithm và thứ tự truy vấn", '2026-03-04', ['cp', 'algorithm'], 8.5, LOREM_CP, 'ghi-chu-thuat-toan'),
      p('2026-03-19-sqrt-decomposition', 'Phân rã căn bậc hai, và khi nào nên dùng', '2026-03-19', ['cp', 'algorithm'], 6, `${LOREM_CP}\n\n![Sơ đồ phân rã](/assets/so-do-sqrt.svg)\n`, 'ghi-chu-thuat-toan'),
    ],
  },
  {
    now: '2026-04-30',
    note: 'Tháng bận: năm bài, nên khối tách theo quy tắc kích thước (4 + 1).',
    posts: [
      p('2026-04-02-fenwick', 'Fenwick tree, bản tôi luôn nhớ được', '2026-04-02', ['cp', 'data-structures'], 4, LOREM_CP, 'ghi-chu-thuat-toan'),
      p('2026-04-08-rust-cli', 'Dựng một CLI nhỏ bằng Rust', '2026-04-08', ['rust', 'tooling'], 12.5, LOREM_SW),
      p('2026-04-15-doc-va-viet', 'Đọc thì dễ, viết mới khó', '2026-04-15', ['essay'], undefined, LOREM_ESSAY),
      p('2026-04-21-merkle', 'Cây Merkle giải thích không cần toán', '2026-04-21', ['blockchain'], 9, `${LOREM_CHAIN}\n\n![Cây Merkle](/assets/so-do-merkle.svg)\n`),
      p('2026-04-27-type-driven', 'Để trình biên dịch giữ hộ bất biến', '2026-04-27', ['rust', 'essay'], 5.5, LOREM_SW),
    ],
  },
  {
    now: '2026-05-31',
    note: 'Tháng im lặng: không bài nào, nhưng khối rỗng vẫn được đào.',
    posts: [],
  },
  {
    now: '2026-06-30',
    note: 'Một bài, cộng bản đính chính cho bài tháng Ba đã niêm phong.',
    posts: [
      p('2026-06-11-proof-of-work', 'Proof of work nhìn từ phía người viết blog', '2026-06-11', ['blockchain', 'essay'], 7, LOREM_CHAIN),
    ],
    amend: {
      slug: '2026-03-04-mo-algorithm',
      title: "Mo's algorithm và thứ tự truy vấn (viết lại)",
      research: 11,
      appendBody: '\nBổ sung sau khi đọc lại: phần chứng minh độ phức tạp ở trên còn thiếu một bước.\n',
    },
  },
  {
    now: '2026-07-31',
    note: 'Ba bài, một dùng lại sơ đồ đã mint ở tháng Tư.',
    posts: [
      p('2026-07-05-segment-tree', 'Segment tree: từ đệ quy sang lặp', '2026-07-05', ['cp', 'data-structures'], 10, `${LOREM_CP}\n\n![Sơ đồ phân rã](/assets/so-do-sqrt.svg)\n`, 'ghi-chu-thuat-toan'),
      p('2026-07-14-static-site', 'Vì sao tôi chọn trang tĩnh', '2026-07-14', ['tooling', 'essay'], 3.5, LOREM_SW),
      p('2026-07-26-hash-functions', 'Hàm băm làm được gì và không làm được gì', '2026-07-26', ['blockchain'], undefined, LOREM_CHAIN),
      // Deliberately the long one: the reading indicator only appears when an
      // article is taller than the viewport, and a code block and display math
      // need somewhere real to be looked at inside the article card.
      p('2026-07-30-tong-tien-to', 'Tổng tiền tố, và khi nào thì cần hơn thế', '2026-07-30', ['cp', 'algorithm'], 5, LOREM_LONG, 'ghi-chu-thuat-toan'),
    ],
  },
  {
    now: '2026-08-03',
    note: 'Tháng hiện tại: hai bài nằm trong khối đang mở, chưa niêm phong.',
    posts: [
      p('2026-08-01-lazy-propagation', 'Lazy propagation như một lời hứa hoãn lại', '2026-08-01', ['cp', 'data-structures'], 3.5, LOREM_CP, 'ghi-chu-thuat-toan'),
      p('2026-08-02-viet-moi-ngay', 'Viết mỗi ngày, kể cả khi không có gì để nói', '2026-08-02', ['essay'], 1.5, LOREM_ESSAY),
    ],
  },
];

/** Every path the seeder creates, for `demo:clear` to remove exactly. */
export function demoPaths(): string[] {
  return [
    ...DEMO_ROUNDS.flatMap((r) => r.posts.map((post) => `content/posts/${post.slug}.md`)),
    ...DEMO_ASSETS.map((a) => `content/assets/${a.file}`),
    ...DEMO_DRAFTS.map((d) => `content/drafts/${d.slug}.md`),
    ...DEMO_CONTRACTS.map((c) => `content/contracts/${c.slug}.md`),
  ];
}

/** A demo contract as `content/contracts/<slug>.md` (§5.1 — never hashed). */
export function contractFile(contract: DemoContract): string {
  const lines = [
    '---',
    `name: ${JSON.stringify(contract.name)}`,
    `summary: ${JSON.stringify(contract.summary)}`,
    `language: ${JSON.stringify(contract.language)}`,
  ];
  // Absent, not empty: an unwritten `repo:` line is what an author's own
  // half-filled file looks like, and it is the input the "no repo, no link"
  // rule is under.
  if (contract.repo !== undefined) lines.push(`repo: ${JSON.stringify(contract.repo)}`);
  lines.push('---', '', contract.body, '');
  return lines.join('\n');
}

export function postFile(post: DemoPost): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(post.title)}`,
    `date: ${post.date}`,
    `tags: [${post.tags.join(', ')}]`,
  ];
  if (post.series !== undefined) lines.push(`series: ${JSON.stringify(post.series)}`);
  if (post.research !== undefined) lines.push(`research: ${post.research.toFixed(1)}`);
  lines.push('---', '', post.body, '');
  return lines.join('\n');
}
