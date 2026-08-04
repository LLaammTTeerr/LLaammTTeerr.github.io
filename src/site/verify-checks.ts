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
      'khớp với nội dung hiện bên cạnh: một tiêu đề bị sửa vẫn qua sạch sẽ.',
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
      'không thấp hơn độ khó của cả chuỗi.',
  },
];
