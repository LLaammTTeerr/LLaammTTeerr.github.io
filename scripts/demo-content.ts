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

const LOREM_CHAIN = `
Một chuỗi khối không có gì huyền bí: nó là danh sách liên kết mà mỗi nút mang
băm của nút trước. Tính bất biến đến từ chỗ đó, không đến từ thuật toán đồng
thuận hay từ tiền mã hoá.

Điều thú vị là khi bỏ hết phần tiền tệ đi, cấu trúc còn lại vẫn hữu ích cho bất
kỳ thứ gì cần lịch sử chống sửa đổi — kể cả một cái blog.
`.trim();

/** Two diagrams, referenced by posts so they mint as tokens (§3.2b). */
export const DEMO_ASSETS: { file: string; svg: string }[] = [
  {
    file: 'so-do-sqrt.svg',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96"><rect width="320" height="96" fill="#0d1117"/><g fill="none" stroke="#7ee787" stroke-width="2">${[
      0, 1, 2, 3,
    ]
      .map((i) => `<rect x="${12 + i * 76}" y="24" width="64" height="48" rx="4"/>`)
      .join('')}</g><text x="160" y="88" fill="#8b949e" font-family="monospace" font-size="11" text-anchor="middle">sqrt decomposition</text></svg>`,
  },
  {
    file: 'so-do-merkle.svg',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140"><rect width="320" height="140" fill="#0d1117"/><g stroke="#79c0ff" stroke-width="2" fill="none"><circle cx="160" cy="24" r="12"/><circle cx="96" cy="76" r="12"/><circle cx="224" cy="76" r="12"/><circle cx="64" cy="124" r="10"/><circle cx="128" cy="124" r="10"/><circle cx="192" cy="124" r="10"/><circle cx="256" cy="124" r="10"/><path d="M152 32 106 66M168 32 214 66M88 86 70 112M104 86 122 112M216 86 198 112M232 86 250 112"/></g></svg>`,
  },
];

/** Drafts — deliberately never on the chain (§3.6, §5.1). */
export const DEMO_DRAFTS: { slug: string; title: string; date: string }[] = [
  { slug: 'wip-cay-phan-doan', title: 'Cây phân đoạn với lazy propagation', date: '2026-08-01' },
  { slug: 'wip-trinh-bien-dich', title: 'Viết một trình biên dịch nhỏ bằng Rust', date: '2026-07-28' },
  { slug: 'wip-doc-sach', title: 'Ghi chú đọc sách quý này', date: '2026-08-02' },
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
  ];
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
