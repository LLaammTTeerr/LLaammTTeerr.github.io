---
title: "Để trình biên dịch giữ hộ bất biến"
date: 2026-04-27
tags: [rust, essay]
research: 5.5
---

Phần khó nhất không phải là viết code, mà là quyết định cái gì thuộc về đâu.
Khi một tệp bắt đầu làm hai việc, mọi thay đổi sau đó đều phải đọc cả hai.

Tôi tách theo trách nhiệm chứ không theo tầng kỹ thuật: những thứ thay đổi cùng
nhau thì nằm cùng nhau. Cách này khiến số tệp nhiều hơn nhưng mỗi tệp đọc được
trong một lần.
