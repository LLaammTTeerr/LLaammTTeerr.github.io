---
title: "Tổng tiền tố, và khi nào thì cần hơn thế"
date: 2026-07-30
tags: [cp, algorithm]
series: "ghi-chu-thuat-toan"
research: 5.0
---

Bài này dài hơn hẳn các bài khác trong bộ mẫu, và có chủ đích: thanh tiến độ đọc
chỉ hiện khi bài cao hơn màn hình, còn khối mã và công thức thì cần một chỗ thật
để xem chúng cư xử ra sao bên trong thẻ bài viết.

## Bài toán

Cho một mảng `a` gồm `n` phần tử và `q` truy vấn, mỗi truy vấn hỏi tổng của một
đoạn con. Cách ngây thơ mất `O(nq)`, quá chậm khi cả hai đều tới `10^5`.

Gọi $S_i$ là tổng tiền tố tới vị trí $i$. Khi đó tổng đoạn $[l, r]$ chính là
$S_r - S_{l-1}$, và mỗi truy vấn trở thành một phép trừ.

$$
S_i = \sum_{k=1}^{i} a_k \qquad \text{tong}(l, r) = S_r - S_{l-1}
$$

## Cài đặt

Phần khó không nằm ở ý tưởng mà ở chỉ số. Tôi luôn để `S` lệch một, tức
`S[0] = 0`, để không phải viết trường hợp riêng cho `l = 1`:

```cpp
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
        cout << S[r] - S[l - 1] << '\n';
    }
    return 0;
}
```

Kiểu `long long` không phải để cho chắc: với `n = 10^5` phần tử mỗi phần tử tới
`10^9`, tổng đã vượt `int` từ lâu. Đây là lỗi tôi mắc nhiều lần nhất.

## Khi mảng thay đổi

Tiền tố chỉ đúng với mảng tĩnh. Cập nhật một phần tử làm hỏng mọi `S_i` phía sau,
nên chi phí cập nhật là $O(n)$. Lúc đó mới cần tới Fenwick hoặc segment tree, và
đánh đổi trở thành:

| Cấu trúc | Truy vấn | Cập nhật |
|---|---|---|
| Tiền tố | $O(1)$ | $O(n)$ |
| Fenwick | $O(\log n)$ | $O(\log n)$ |
| Segment tree | $O(\log n)$ | $O(\log n)$ |

Nếu đề chỉ hỏi mà không sửa, đừng viết segment tree. Tôi đã mất khá nhiều thời
gian cho những cây không ai đụng tới.

## Một lưu ý cuối

Đọc vào bằng `cin` không tắt đồng bộ thì `10^5` truy vấn cũng đủ chậm để trượt
giới hạn. Hai dòng `sync_with_stdio` và `tie` ở đầu `main` không phải mê tín.
