/**
 * §7 — the checks `/verify` runs on every block, named once.
 *
 * Three things read this list: the page's own prose, which describes what is
 * about to happen while there is still nothing on screen; the island script,
 * which labels each result as it lands; and the test that holds the two to
 * each other. A label spelled in the template and again in the script is two
 * labels the moment one is edited, and on this page that would mean a reader
 * being told one thing and shown another about what was actually proven.
 *
 * `field` is the `BlockVerification` key each check reports, so the island
 * cannot invent a check the verifier does not run, nor quietly drop one it
 * does. The five here are exactly `BlockVerification`'s five verdict fields.
 *
 * Explorer chrome is English and author-facing prose is Vietnamese (§9), so
 * the label is the field's name as a blockchain explorer would print it and
 * the note is what it means, for the reader.
 *
 * No clock here or anywhere under `src/site/` (§14).
 */

export interface CheckSpec {
  /** The `BlockVerification` field this check reports. */
  field: 'hashOk' | 'merkleOk' | 'txOk' | 'linkOk' | 'powOk';
  label: string;
  note: string;
}

/** The stamp, the status line and the paragraph `/verify` finishes on. */
export interface ChainVerdict {
  /** The stamp's `data-state`. */
  state: 'ok' | 'fail' | 'idle';
  stamp: string;
  /** The live-region line above the results. */
  status: string;
  verdict: string;
}

/**
 * §7 — which verdict `/verify` reaches, decided once and away from the DOM.
 *
 * Extracted from the island because the branch **order** here is a finding, and
 * a branch order buried in a component that only a browser can run is a branch
 * order nothing tests. `verifyChainStream` returns the chain-level problem —
 * "this is not a chain", "it declares no difficulty floor", "the asset registry
 * disagrees with the transactions" — and the island used to compute it, then
 * discard it three lines later behind an `index === 0` early return. Four
 * different malformed ledgers (`{"version":1}`, `[]`, `"hello"`, and a
 * genuinely empty `{"blocks":[]}`) all reached the reader as *"Chuỗi chưa có
 * khối nào để kiểm"* — the chain has no blocks to check. Never a pass, so never
 * a false green; but on the one page whose purpose is a legible verdict, a
 * confidently wrong diagnosis is the wrong failure mode, and the right string
 * had already been computed.
 *
 * So: the problem is answered first, and "empty" now means only what it says.
 *
 * Pure, and reads no clock (§14).
 */
export function chainVerdict(blocks: number, failed: number, problem: string | null): ChainVerdict {
  if (problem !== null) {
    return {
      state: 'fail',
      stamp: 'Failed',
      status: 'Xong. Tài liệu này không kiểm được như một chuỗi.',
      verdict:
        blocks === 0
          ? `Không kiểm được: ${problem}.`
          : `${String(blocks)} khối đã kiểm, nhưng chuỗi vẫn không hợp lệ: ${problem}.` +
            (failed === 0 ? '' : ` ${String(failed)}/${String(blocks)} khối cũng không khớp.`),
    };
  }
  if (blocks === 0) {
    return {
      state: 'idle',
      stamp: 'Trống',
      status: 'Đã tải /chain.json.',
      verdict: 'Chuỗi chưa có khối nào để kiểm.',
    };
  }
  if (failed === 0) {
    return {
      state: 'ok',
      stamp: 'Verified',
      status: 'Xong. Mỗi hash dưới đây do chính máy bạn tính lại, từ dữ liệu thô.',
      verdict:
        'Chuỗi hợp lệ. Mọi hash khối, gốc Merkle, hash giao dịch, tổng gas/value, liên kết prevHash ' +
        'và bằng chứng công việc đều tính lại khớp — bạn không phải tin trang này, bạn vừa tự kiểm. ' +
        'Trong giới hạn ghi rõ bên dưới: gasUsed và value của từng giao dịch chỉ được kiểm ở mức ' +
        'tổng của khối, không phải từng con số.',
    };
  }
  return {
    state: 'fail',
    stamp: 'Failed',
    status: 'Xong. Có thứ không khớp — xem khối được đánh dấu bên dưới.',
    verdict: `${String(failed)}/${String(blocks)} khối không khớp: dữ liệu bên dưới không phải thứ đã được băm.`,
  };
}

export const CHECKS: CheckSpec[] = [
  {
    field: 'hashOk',
    label: 'Block hash',
    note:
      'Băm lại header của khối — height, prevHash, merkleRoot, timestamp, txCount, gasUsed, ' +
      'difficulty, nonce — rồi so với hash đã ghi. Tám trường đó là toàn bộ những gì hash cam kết; ' +
      'period không nằm trong header nên không có hash nào bảo chứng cho nó.',
  },
  {
    field: 'merkleOk',
    label: 'Merkle root',
    note: 'Dựng lại cây Merkle từ hash của từng giao dịch trong khối, rồi so với gốc đã ghi trong header.',
  },
  {
    field: 'txOk',
    label: 'Transaction hashes',
    note:
      'Băm lại từng giao dịch từ chính nội dung của nó, và cộng lại gasUsed cùng value của cả khối. ' +
      'Chỉ kiểm Merkle root thì mới chứng minh được các hash đã ghi khớp với nhau, chứ không phải ' +
      'khớp với nội dung hiện bên cạnh: một tiêu đề bị sửa vẫn qua sạch sẽ. Nói rõ giới hạn: gasUsed ' +
      'và value của từng giao dịch không nằm trong dạng chuẩn nên không hash giao dịch nào bảo ' +
      'chứng cho chúng — ở đây chỉ kiểm được tổng của cả khối, và một tổng thì không đổi khi ' +
      'chuyển bớt từ giao dịch này sang giao dịch khác. Muốn kiểm đúng con số của một bài thì phải ' +
      'có thân bài để đếm lại, và đó là việc của nút “Verify this transaction” trên chính trang bài.',
  },
  {
    field: 'linkOk',
    label: 'prevHash link',
    note: 'Khối trỏ đúng vào hash của khối liền trước và cao hơn đúng một bậc; khối đầu tiên trỏ vào 0.',
  },
  {
    field: 'powOk',
    label: 'Proof of work',
    note:
      'Hash bắt đầu bằng đúng số chữ số 0 mà chính khối đó cam kết trong header, và độ khó ấy ' +
      'không thấp hơn độ khó của cả chuỗi. Sàn ấy đọc từ chính tài liệu đang bị kiểm: một sổ cái ' +
      'khai difficulty 0 vẫn qua được phép kiểm này (khai thiếu hẳn thì bị báo hỏng). Neo thật nằm ' +
      'ở chain.lock.json trong kho mã, không ở đây.',
  },
];
