---
title: "Segment tree: từ đệ quy sang lặp"
date: 2026-07-05
tags: [cp, data-structures]
series: "ghi-chu-thuat-toan"
research: 10.0
---

Bài toán yêu cầu trả lời nhiều truy vấn trên một mảng tĩnh, và giới hạn khiến
cách làm ngây thơ không kịp. Ý tưởng ở đây là chia mảng thành các khối có kích
thước xấp xỉ căn bậc hai của độ dài, rồi tiền xử lý từng khối.

Điểm dễ sai là biên: khi truy vấn nằm gọn trong một khối, ta phải xử lý riêng
thay vì đi qua vòng lặp chung. Tôi đã mất khá nhiều lần nộp bài mới nhận ra.

Độ phức tạp cuối cùng vào khoảng `O((n + q) * sqrt(n))`, đủ cho giới hạn đề bài.

![Sơ đồ phân rã](/assets/so-do-sqrt.svg)

