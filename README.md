# TSEZY 智能自动标注网站

一个可在本机运行的目标检测数据集标注网站，后端使用 Flask，AI 推理使用 Ultralytics YOLO。

## 功能

- 多图片选择、拖放导入
- 上传进度弹窗与文件传输状态
- 基于 SHA-256 文件内容的重复图片识别
- 支持删除单张图片或清空项目全部图片
- 浏览器 Canvas 手工矩形框标注
- 类别管理、逐图自动保存
- YOLO 模型批量 AI 标注
- 可选择跳过已有标注，或覆盖已有标注
- 导出 YOLO、COCO、Pascal VOC、LabelMe
- 默认支持仅导出 YOLO TXT 标签，不重复打包原始图片
- 项目和标注保存在本地 `data/projects/`
- 深色/浅色主题与 Lucide SVG 图标视觉系统

## 运行

```powershell
pip install -r requirements.txt
python app.py
```

浏览器访问 <http://127.0.0.1:5000>。

## 使用自己的模型

把模型放入 `models/`，例如 `models/best.pt`，在网页模型输入框填写 `best.pt`。也可以填写绝对路径。填写 `yolo11n.pt` 等官方模型名时，Ultralytics 首次使用会从网络下载权重。

自动标注产生的是候选框，建议人工逐图复核后再用于训练。生产环境还应增加登录鉴权、任务队列、数据库、对象存储、GPU worker 和数据备份。
