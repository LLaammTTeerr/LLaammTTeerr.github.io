---
title: "Mo's algorithm và thứ tự truy vấn (viết lại)"
date: 2026-03-04
tags: [cp, algorithm]
series: "ghi-chu-thuat-toan"
research: 11.0
---

Bài toán yêu cầu trả lời nhiều truy vấn trên một mảng tĩnh, và giới hạn khiến
cách làm ngây thơ không kịp. Ý tưởng ở đây là chia mảng thành các khối có kích
thước xấp xỉ căn bậc hai của độ dài, rồi tiền xử lý từng khối.

Điểm dễ sai là biên: khi truy vấn nằm gọn trong một khối, ta phải xử lý riêng
thay vì đi qua vòng lặp chung. Tôi đã mất khá nhiều lần nộp bài mới nhận ra.

Độ phức tạp cuối cùng vào khoảng `O((n + q) * sqrt(n))`, đủ cho giới hạn đề bài.

Bổ sung sau khi đọc lại: phần chứng minh độ phức tạp ở trên còn thiếu một bước.
