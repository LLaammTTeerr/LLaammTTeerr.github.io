/**
 * §7 — the four links "Verify this transaction" checks, named once.
 *
 * The sibling of `verify-checks.ts`, and it exists for the same reason: the
 * control's static markup describes what is about to happen while there is
 * still nothing on screen, and the island labels each result as it lands. A
 * label spelled in the template and again in the script is two labels the
 * moment one is edited, and here that would mean a reader being told one thing
 * and shown another about what was actually proven.
 *
 * `field` is the `TxVerification` key each step reports, so the control cannot
 * invent a check `verifyTransaction` does not run nor quietly drop one it does.
 * The five here are exactly `TxVerification`'s five verdict fields, and
 * `tests/site/tx-verify.test.ts` holds the two lists to each other.
 *
 * Explorer chrome is English and author-facing prose is Vietnamese (§9), so
 * the label is the field's name as a blockchain explorer would print it and the
 * note is what it means, for the reader.
 *
 * No clock here or anywhere under `src/site/` (§14).
 */

export interface TxCheckSpec {
  /** The `TxVerification` field this step reports. */
  field: 'recordOk' | 'bodyOk' | 'txOk' | 'merkleOk' | 'blockOk';
  label: string;
  note: string;
  /**
   * True when the step needs a **mined** block, and so cannot run at all for a
   * transaction still in the open block (§3.6).
   *
   * The control renders these as *not checked* on a pending post, with the
   * reason in the page itself. Rendering them as passed would claim a check
   * that never ran; rendering them as failed would accuse an honest chain;
   * leaving them out entirely would let a reader take a green verdict as
   * covering rather more than it does.
   */
  sealedOnly: boolean;
}

export const TX_CHECKS: TxCheckSpec[] = [
  {
    field: 'recordOk',
    label: 'Chain record',
    note:
      'Tìm trong /chain.json (và /chain.pending.json) bản ghi mới nhất mà chuỗi đang dùng cho bài ' +
      'này — giao dịch gốc, hoặc bản đính chính mới nhất đè lên nó — rồi so với hash mà trang này ' +
      'in ở trên. Bản ghi được tự tìm lấy chứ không tin theo trang: một trang trỏ sang giao dịch ' +
      'khác sẽ lộ ra ở đây.',
    sealedOnly: false,
  },
  {
    field: 'bodyOk',
    label: 'Content hash',
    note:
      'Tải văn bản gốc của chính bài này (body.txt — Markdown đã chuẩn hoá, đúng từng byte đã được ' +
      'băm), băm SHA-256 ngay trong trình duyệt bạn, rồi so với contentHash mà giao dịch cam ' +
      'kết. Đây là mắt xích duy nhất nối chữ bạn vừa đọc với chuỗi: sổ cái chỉ lưu hash, không lưu ' +
      'thân bài.',
    sealedOnly: false,
  },
  {
    field: 'txOk',
    label: 'Transaction hash',
    note:
      'Dựng lại dạng chuẩn của giao dịch từ chính các trường đã ghi — tiêu đề, ngày, tag, series, ' +
      'giờ nghiên cứu, địa chỉ gửi, danh sách tài sản và contentHash ở trên — rồi băm lại. Thiếu ' +
      'bước này thì một tiêu đề bị sửa vẫn qua sạch sẽ, vì cây Merkle chỉ bảo chứng các hash đã ghi ' +
      'khớp với nhau chứ không khớp với nội dung bên cạnh.',
    sealedOnly: false,
  },
  {
    field: 'merkleOk',
    label: 'Merkle root',
    note:
      'Dựng lại cây Merkle từ hash của mọi giao dịch trong khối đã niêm phong bài này, và kiểm rằng ' +
      'hash giao dịch trên nằm trong số lá của cây, rồi so gốc dựng được với gốc đã ghi trong header.',
    sealedOnly: true,
  },
  {
    field: 'blockOk',
    label: 'Block hash',
    note:
      'Băm lại header của khối đó — height, prevHash, merkleRoot, timestamp, txCount, gasUsed, ' +
      'difficulty, nonce — so với hash đã đào, và kiểm rằng hash ấy bắt đầu bằng đúng số chữ số 0 ' +
      'mà khối tự cam kết. Đến đây thì vòng đã khép: từ chữ thô đến hash khối.',
    sealedOnly: true,
  },
];
