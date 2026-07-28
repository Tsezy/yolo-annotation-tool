from __future__ import annotations

import io
import hashlib
import json
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from PIL import Image
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
MODELS_DIR = BASE_DIR / "models"
ALLOWED_IMAGES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

_model_cache: dict[str, object] = {}


def project_dir(project_id: str) -> Path:
    if not project_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in project_id):
        raise ValueError("无效的项目 ID")
    return PROJECTS_DIR / project_id


def meta_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def load_project(project_id: str) -> dict:
    path = meta_path(project_id)
    if not path.exists():
        raise FileNotFoundError("项目不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def save_project(project: dict) -> None:
    folder = project_dir(project["id"])
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "images").mkdir(exist_ok=True)
    meta_path(project["id"]).write_text(
        json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_image_hashes(project: dict) -> bool:
    changed = False
    folder = project_dir(project["id"]) / "images"
    for item in project.get("images", []):
        if not item.get("sha256"):
            path = folder / item["stored_name"]
            if path.exists():
                item["sha256"] = file_sha256(path)
                changed = True
    return changed


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/projects")
def list_projects():
    projects = []
    for path in PROJECTS_DIR.glob("*/project.json"):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
            projects.append({
                "id": project["id"],
                "name": project["name"],
                "image_count": len(project.get("images", [])),
            })
        except (OSError, ValueError, KeyError):
            continue
    return jsonify({"ok": True, "projects": projects})


@app.get("/api/models")
def list_models():
    models = []
    for path in sorted(MODELS_DIR.glob("*.pt")):
        size_mb = path.stat().st_size / (1024 * 1024)
        models.append({"value": path.name, "label": f"{path.name}（{size_mb:.1f} 兆字节）"})
    return jsonify({"ok": True, "models": models})


@app.post("/api/projects")
def create_project():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "未命名项目")).strip() or "未命名项目"
    classes = payload.get("classes") or ["object"]
    classes = [str(item).strip() for item in classes if str(item).strip()]
    if not classes:
        classes = ["object"]
    project = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "classes": classes,
        "images": [],
        "annotations": {},
    }
    save_project(project)
    return jsonify({"ok": True, "project": project})


@app.get("/api/projects/<project_id>")
def get_project(project_id: str):
    try:
        return jsonify({"ok": True, "project": load_project(project_id)})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.patch("/api/projects/<project_id>")
def update_project(project_id: str):
    try:
        project = load_project(project_id)
        payload = request.get_json(force=True)
        if "remove_class_id" in payload:
            class_id = int(payload["remove_class_id"])
            if class_id < 0 or class_id >= len(project["classes"]):
                return error("标签不存在")
            used = sum(
                1 for image_boxes in project.get("annotations", {}).values()
                for box in image_boxes if int(box.get("class_id", -1)) == class_id
            )
            if used:
                return error(f"该标签正在被 {used} 个标注框使用，无法删除", 409)
            project["classes"].pop(class_id)
            for image_boxes in project.get("annotations", {}).values():
                for box in image_boxes:
                    if int(box.get("class_id", -1)) > class_id:
                        box["class_id"] = int(box["class_id"]) - 1
        if "classes" in payload:
            classes = [str(x).strip() for x in payload["classes"] if str(x).strip()]
            if not classes:
                return error("至少需要一个标签")
            project["classes"] = classes
        if "name" in payload:
            project["name"] = str(payload["name"]).strip() or project["name"]
        save_project(project)
        return jsonify({"ok": True, "project": project})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.post("/api/projects/<project_id>/images")
def upload_images(project_id: str):
    try:
        project = load_project(project_id)
        files = request.files.getlist("images")
        if not files:
            return error("请选择图片")
        added = []
        duplicates = []
        folder = project_dir(project_id) / "images"
        hashes_changed = ensure_image_hashes(project)
        existing_hashes = {item.get("sha256") for item in project["images"] if item.get("sha256")}
        existing_names = {item["name"] for item in project["images"]}
        for file in files:
            suffix = Path(file.filename or "").suffix.lower()
            if suffix not in ALLOWED_IMAGES:
                continue
            original = secure_filename(file.filename) or f"image{suffix}"
            display_name = original
            stem, ext = Path(original).stem, Path(original).suffix
            n = 1
            while display_name in existing_names:
                display_name = f"{stem}_{n}{ext}"
                n += 1
            image_id = uuid.uuid4().hex[:16]
            stored_name = f"{image_id}{suffix}"
            destination = folder / stored_name
            file.save(destination)
            image_hash = file_sha256(destination)
            if image_hash in existing_hashes:
                destination.unlink(missing_ok=True)
                duplicates.append({"name": file.filename or original, "reason": "文件内容重复"})
                continue
            try:
                with Image.open(destination) as img:
                    width, height = img.size
            except Exception:
                destination.unlink(missing_ok=True)
                continue
            record = {
                "id": image_id,
                "name": display_name,
                "stored_name": stored_name,
                "width": width,
                "height": height,
                "sha256": image_hash,
            }
            project["images"].append(record)
            project["annotations"][image_id] = []
            existing_names.add(display_name)
            existing_hashes.add(image_hash)
            added.append(record)
        if added or hashes_changed:
            save_project(project)
        return jsonify({"ok": True, "added": added, "duplicates": duplicates, "project": project})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.get("/api/projects/<project_id>/images/<image_id>")
def serve_image(project_id: str, image_id: str):
    try:
        project = load_project(project_id)
        item = next((x for x in project["images"] if x["id"] == image_id), None)
        if not item:
            return error("图片不存在", 404)
        return send_from_directory(project_dir(project_id) / "images", item["stored_name"])
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.delete("/api/projects/<project_id>/images/<image_id>")
def delete_image(project_id: str, image_id: str):
    try:
        project = load_project(project_id)
        item = next((value for value in project["images"] if value["id"] == image_id), None)
        if not item:
            return error("图片不存在", 404)
        path = project_dir(project_id) / "images" / item["stored_name"]
        path.unlink(missing_ok=True)
        project["images"] = [value for value in project["images"] if value["id"] != image_id]
        project["annotations"].pop(image_id, None)
        save_project(project)
        return jsonify({"ok": True, "project": project})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.delete("/api/projects/<project_id>/images")
def delete_all_images(project_id: str):
    try:
        project = load_project(project_id)
        folder = project_dir(project_id) / "images"
        for item in project["images"]:
            (folder / item["stored_name"]).unlink(missing_ok=True)
        deleted = len(project["images"])
        project["images"] = []
        project["annotations"] = {}
        project["classes"] = []
        save_project(project)
        return jsonify({"ok": True, "deleted": deleted, "project": project})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.delete("/api/projects/<project_id>/annotations/ai-pending")
def cancel_all_pending_ai_annotations(project_id: str):
    try:
        project = load_project(project_id)
        affected_images = 0
        removed_boxes = 0
        for item in project.get("images", []):
            if item.get("review_status") != "ai_pending":
                continue
            image_id = item["id"]
            current = project.get("annotations", {}).get(image_id, [])
            kept = [box for box in current if box.get("source") == "manual"]
            removed = len(current) - len(kept)
            if removed:
                affected_images += 1
                removed_boxes += removed
            project["annotations"][image_id] = kept
            if kept:
                item["review_status"] = "confirmed"
            else:
                item.pop("review_status", None)
        save_project(project)
        return jsonify({"ok": True, "project": project,
                        "images": affected_images, "boxes": removed_boxes})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.post("/api/projects/<project_id>/images/<image_id>/confirm")
def confirm_image_annotations(project_id: str, image_id: str):
    try:
        project = load_project(project_id)
        item = next((value for value in project["images"] if value["id"] == image_id), None)
        if not item:
            return error("图片不存在", 404)
        if not project["annotations"].get(image_id):
            return error("当前图片没有可确认的标注")
        for box in project["annotations"][image_id]:
            box["confidence"] = None
        item["review_status"] = "confirmed"
        save_project(project)
        return jsonify({"ok": True, "project": project})
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


@app.put("/api/projects/<project_id>/annotations/<image_id>")
def save_annotations(project_id: str, image_id: str):
    try:
        project = load_project(project_id)
        if image_id not in {x["id"] for x in project["images"]}:
            return error("图片不存在", 404)
        payload = request.get_json(force=True)
        boxes = payload.get("boxes", [])
        clean = []
        for box in boxes:
            class_id = int(box["class_id"])
            if class_id < 0 or class_id >= len(project["classes"]):
                return error("标注类别超出范围")
            x, y = max(0.0, float(box["x"])), max(0.0, float(box["y"]))
            w, h = max(1.0, float(box["w"])), max(1.0, float(box["h"]))
            source = box.get("source", "manual")
            clean.append({"class_id": class_id, "x": x, "y": y, "w": w, "h": h,
                          "confidence": None if source == "manual" else box.get("confidence"), "source": source})
        project["annotations"][image_id] = clean
        item = next((value for value in project["images"] if value["id"] == image_id), None)
        if item is not None:
            if any(box.get("source") == "manual" for box in clean):
                item["review_status"] = "confirmed"
            elif not clean:
                item.pop("review_status", None)
        save_project(project)
        return jsonify({"ok": True, "boxes": clean})
    except (FileNotFoundError, ValueError, TypeError, KeyError) as exc:
        return error(str(exc))


def resolve_model(model_name: str) -> str:
    candidate = Path(model_name)
    if candidate.is_absolute() and candidate.exists():
        return str(candidate)
    local = MODELS_DIR / model_name
    if local.exists():
        return str(local)
    # Ultralytics can resolve/download official names such as yolo11n.pt.
    return model_name


@app.post("/api/projects/<project_id>/auto-annotate")
def auto_annotate(project_id: str):
    try:
        from ultralytics import YOLO

        project = load_project(project_id)
        payload = request.get_json(silent=True) or {}
        model_name = str(payload.get("model", "yolo11n.pt")).strip() or "yolo11n.pt"
        confidence = min(1.0, max(0.01, float(payload.get("confidence", 0.25))))
        include_annotated = bool(payload.get("include_annotated", False))
        selected_ids = set(payload.get("image_ids") or [x["id"] for x in project["images"]])
        manual_class_ids = {
            int(box["class_id"])
            for image_boxes in project.get("annotations", {}).values()
            for box in image_boxes
            if box.get("source") == "manual"
            and 0 <= int(box.get("class_id", -1)) < len(project["classes"])
        }
        if False and not manual_class_ids:
            return error("请先完成至少一个手工标注，再运行 AI 标注", 400)
        allowed_label_names = {project["classes"][class_id] for class_id in manual_class_ids}
        model_path = resolve_model(model_name)
        model = _model_cache.get(model_path)
        if model is None:
            model = YOLO(model_path)
            _model_cache[model_path] = model

        processed, skipped, total_boxes, ignored_boxes = 0, 0, 0, 0
        for item in project["images"]:
            image_id = item["id"]
            if image_id not in selected_ids:
                continue
            current = project["annotations"].get(image_id, [])
            if current and not include_annotated:
                skipped += 1
                continue
            image_path = project_dir(project_id) / "images" / item["stored_name"]
            result = model.predict(source=str(image_path), conf=confidence, verbose=False)[0]
            generated = []
            if result.boxes is not None:
                xyxy = result.boxes.xyxy.cpu().tolist()
                class_ids = result.boxes.cls.cpu().tolist()
                scores = result.boxes.conf.cpu().tolist()
                names = result.names
                for coords, cls_id, score in zip(xyxy, class_ids, scores):
                    source_id = int(cls_id)
                    class_name = str(names[source_id])
                    if False and class_name not in allowed_label_names:
                        ignored_boxes += 1
                        continue
                    if class_name not in project["classes"]:
                        project["classes"].append(class_name)
                    target_id = project["classes"].index(class_name)
                    x1, y1, x2, y2 = coords
                    generated.append({
                        "class_id": target_id, "x": x1, "y": y1,
                        "w": x2 - x1, "h": y2 - y1,
                        "confidence": round(float(score), 4), "source": "ai",
                    })
            project["annotations"][image_id] = generated
            item["review_status"] = "ai_pending"
            processed += 1
            total_boxes += len(generated)
        save_project(project)
        return jsonify({"ok": True, "project": project, "processed": processed,
                        "skipped": skipped, "boxes": total_boxes,
                        "ignored_boxes": ignored_boxes,
                        "allowed_labels": sorted(allowed_label_names)})
    except ImportError:
        return error("未安装 ultralytics，请执行 pip install ultralytics", 500)
    except Exception as exc:
        return error(f"自动标注失败：{exc}", 500)


@app.post("/api/projects/<project_id>/track-step")
def track_step(project_id: str):
    """Propagate one bounding box between adjacent video frames."""
    try:
        import cv2
        import numpy as np

        project = load_project(project_id)
        payload = request.get_json(force=True)
        source_id = str(payload["source_image_id"])
        target_id = str(payload["target_image_id"])
        seed = payload["box"]
        replace = bool(payload.get("replace", False))
        scale_limit_enabled = bool(payload.get("scale_limit_enabled", True))
        max_scale_change = min(0.5, max(0.005, float(payload.get("max_scale_change", 0.04))))
        template_refine_enabled = bool(payload.get("template_refine_enabled", True))
        template_search_ratio = min(2.0, max(0.1, float(payload.get("template_search_ratio", 0.7))))
        template_scale_range = min(0.4, max(0.0, float(payload.get("template_scale_range", 0.08))))
        template_match_threshold = min(0.95, max(0.05, float(payload.get("template_match_threshold", 0.35))))
        image_map = {item["id"]: item for item in project["images"]}
        if source_id not in image_map or target_id not in image_map:
            return error("跟踪图片不存在", 404)

        folder = project_dir(project_id) / "images"
        def read_gray(path: Path):
            # cv2.imread is unreliable with non-ASCII paths on Windows.
            encoded = np.fromfile(str(path), dtype=np.uint8)
            return cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE) if encoded.size else None

        previous = read_gray(folder / image_map[source_id]["stored_name"])
        current = read_gray(folder / image_map[target_id]["stored_name"])
        if previous is None or current is None:
            return error("无法读取跟踪图片")

        x, y = float(seed["x"]), float(seed["y"])
        w, h = float(seed["w"]), float(seed["h"])
        x1, y1 = max(0, int(x)), max(0, int(y))
        x2, y2 = min(previous.shape[1], int(x + w)), min(previous.shape[0], int(y + h))
        if x2 - x1 < 4 or y2 - y1 < 4:
            return error("当前框太小，无法跟踪")

        mask = np.zeros_like(previous)
        mask[y1:y2, x1:x2] = 255
        points = cv2.goodFeaturesToTrack(previous, mask=mask, maxCorners=100,
                                         qualityLevel=0.01, minDistance=4, blockSize=5)
        tracked_box = None
        confidence = 0.0
        if points is not None and len(points) >= 3:
            next_points, status, _ = cv2.calcOpticalFlowPyrLK(
                previous, current, points, None, winSize=(31, 31), maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
            good_old = points[status.reshape(-1) == 1]
            good_new = next_points[status.reshape(-1) == 1]
            if len(good_new) >= 3:
                matrix, inliers = cv2.estimateAffinePartial2D(
                    good_old, good_new, method=cv2.RANSAC, ransacReprojThreshold=3.0)
                if matrix is not None:
                    corners = np.float32([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]).reshape(-1, 1, 2)
                    moved = cv2.transform(corners, matrix).reshape(-1, 2)
                    bx1, by1 = moved.min(axis=0)
                    bx2, by2 = moved.max(axis=0)
                    tracked_box = [float(bx1), float(by1), float(bx2 - bx1), float(by2 - by1)]
                    confidence = float(inliers.mean()) if inliers is not None else 0.65

        if tracked_box is None:
            template = previous[y1:y2, x1:x2]
            margin_x, margin_y = max(20, int(w * 0.8)), max(20, int(h * 0.8))
            sx1, sy1 = max(0, x1 - margin_x), max(0, y1 - margin_y)
            sx2, sy2 = min(current.shape[1], x2 + margin_x), min(current.shape[0], y2 + margin_y)
            search = current[sy1:sy2, sx1:sx2]
            if search.shape[0] < template.shape[0] or search.shape[1] < template.shape[1]:
                return error("目标已离开画面，跟踪停止")
            result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
            _, score, _, location = cv2.minMaxLoc(result)
            tracked_box = [float(sx1 + location[0]), float(sy1 + location[1]), w, h]
            confidence = float(score)

        if template_refine_enabled and tracked_box is not None:
            template = previous[y1:y2, x1:x2]
            px, py, pw, ph = tracked_box
            center_x, center_y = px + pw / 2, py + ph / 2
            base_w = w if scale_limit_enabled else pw
            base_h = h if scale_limit_enabled else ph
            largest_scale = 1.0 + template_scale_range
            margin_x = max(20, int(base_w * template_search_ratio))
            margin_y = max(20, int(base_h * template_search_ratio))
            rx1 = max(0, int(center_x - base_w * largest_scale / 2 - margin_x))
            ry1 = max(0, int(center_y - base_h * largest_scale / 2 - margin_y))
            rx2 = min(current.shape[1], int(center_x + base_w * largest_scale / 2 + margin_x))
            ry2 = min(current.shape[0], int(center_y + base_h * largest_scale / 2 + margin_y))
            search = current[ry1:ry2, rx1:rx2]
            best_score, best_box = -1.0, None
            for candidate_scale in np.linspace(1.0 - template_scale_range, 1.0 + template_scale_range, 7):
                candidate_w = max(4, int(round(base_w * float(candidate_scale))))
                candidate_h = max(4, int(round(base_h * float(candidate_scale))))
                if candidate_w > search.shape[1] or candidate_h > search.shape[0]:
                    continue
                resized = cv2.resize(template, (candidate_w, candidate_h), interpolation=cv2.INTER_LINEAR)
                match = cv2.matchTemplate(search, resized, cv2.TM_CCOEFF_NORMED)
                _, score, _, location = cv2.minMaxLoc(match)
                if float(score) > best_score:
                    best_score = float(score)
                    best_box = [float(rx1 + location[0]), float(ry1 + location[1]),
                                float(candidate_w), float(candidate_h)]
            if best_box is not None and best_score >= template_match_threshold:
                tracked_box = best_box
                confidence = best_score

        if tracked_box is not None and scale_limit_enabled:
            limited_x, limited_y, current_w, current_h = tracked_box
            limited_w = min(w * (1 + max_scale_change), max(w * (1 - max_scale_change), current_w))
            limited_h = min(h * (1 + max_scale_change), max(h * (1 - max_scale_change), current_h))
            center_x, center_y = limited_x + current_w / 2, limited_y + current_h / 2
            tracked_box = [center_x - limited_w / 2, center_y - limited_h / 2, limited_w, limited_h]

        tx, ty, tw, th = tracked_box
        tx, ty = max(0.0, tx), max(0.0, ty)
        tw = min(tw, current.shape[1] - tx)
        th = min(th, current.shape[0] - ty)
        if tw < 3 or th < 3 or confidence < 0.12:
            return error("未能可靠定位目标，跟踪停止")
        generated = {"class_id": int(seed["class_id"]), "x": round(tx, 2), "y": round(ty, 2),
                     "w": round(tw, 2), "h": round(th, 2),
                     "confidence": round(confidence, 4), "source": "tracking"}
        existing = project["annotations"].get(target_id, [])
        if replace:
            existing = [box for box in existing if int(box.get("class_id", -1)) != generated["class_id"]]
        existing.append(generated)
        project["annotations"][target_id] = existing
        image_map[target_id]["review_status"] = "ai_pending"
        save_project(project)
        return jsonify({"ok": True, "project": project, "box": generated, "confidence": confidence})
    except ImportError:
        return error("跟踪功能需要 OpenCV 和 NumPy", 500)
    except (FileNotFoundError, ValueError, KeyError, TypeError) as exc:
        return error(str(exc))
    except Exception as exc:
        return error(f"目标跟踪失败：{exc}", 500)


def yolo_text(boxes: list[dict], width: int, height: int) -> str:
    lines = []
    for b in boxes:
        cx = (b["x"] + b["w"] / 2) / width
        cy = (b["y"] + b["h"] / 2) / height
        nw, nh = b["w"] / width, b["h"] / height
        lines.append(f'{b["class_id"]} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}')
    return "\n".join(lines) + ("\n" if lines else "")


def voc_xml(item: dict, boxes: list[dict], classes: list[str]) -> str:
    import xml.etree.ElementTree as ET
    root = ET.Element("annotation")
    ET.SubElement(root, "filename").text = item["name"]
    size = ET.SubElement(root, "size")
    ET.SubElement(size, "width").text = str(item["width"])
    ET.SubElement(size, "height").text = str(item["height"])
    ET.SubElement(size, "depth").text = "3"
    for b in boxes:
        obj = ET.SubElement(root, "object")
        ET.SubElement(obj, "name").text = classes[b["class_id"]]
        ET.SubElement(obj, "pose").text = "Unspecified"
        ET.SubElement(obj, "truncated").text = "0"
        ET.SubElement(obj, "difficult").text = "0"
        bb = ET.SubElement(obj, "bndbox")
        ET.SubElement(bb, "xmin").text = str(round(b["x"]))
        ET.SubElement(bb, "ymin").text = str(round(b["y"]))
        ET.SubElement(bb, "xmax").text = str(round(b["x"] + b["w"]))
        ET.SubElement(bb, "ymax").text = str(round(b["y"] + b["h"]))
    return ET.tostring(root, encoding="unicode")


@app.get("/api/projects/<project_id>/export")
def export_project(project_id: str):
    try:
        project = load_project(project_id)
        fmt = request.args.get("format", "yolo").lower()
        if fmt not in {"yolo_labels", "yolo", "coco", "voc", "labelme"}:
            return error("不支持的导出格式")
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as archive:
            coco_images, coco_annotations = [], []
            ann_id = 1
            for index, item in enumerate(project["images"], start=1):
                source = project_dir(project_id) / "images" / item["stored_name"]
                if fmt != "yolo_labels":
                    archive.write(source, f"images/{item['name']}")
                boxes = project["annotations"].get(item["id"], [])
                stem = Path(item["name"]).stem
                if fmt == "yolo_labels":
                    archive.writestr(
                        f"labels/{stem}.txt",
                        yolo_text(boxes, item["width"], item["height"]),
                    )
                elif fmt == "yolo":
                    archive.writestr(f"labels/{stem}.txt", yolo_text(boxes, item["width"], item["height"]))
                elif fmt == "voc":
                    archive.writestr(f"annotations/{stem}.xml", voc_xml(item, boxes, project["classes"]))
                elif fmt == "labelme":
                    shapes = [{"label": project["classes"][b["class_id"]], "points": [[b["x"], b["y"]], [b["x"] + b["w"], b["y"] + b["h"]]],
                               "group_id": None, "description": "", "shape_type": "rectangle", "flags": {}} for b in boxes]
                    doc = {"version": "5.0.1", "flags": {}, "shapes": shapes, "imagePath": item["name"],
                           "imageData": None, "imageHeight": item["height"], "imageWidth": item["width"]}
                    archive.writestr(f"annotations/{stem}.json", json.dumps(doc, ensure_ascii=False, indent=2))
                else:
                    coco_images.append({"id": index, "file_name": item["name"], "width": item["width"], "height": item["height"]})
                    for b in boxes:
                        coco_annotations.append({"id": ann_id, "image_id": index, "category_id": b["class_id"] + 1,
                                                 "bbox": [b["x"], b["y"], b["w"], b["h"]], "area": b["w"] * b["h"],
                                                 "iscrowd": 0, "segmentation": []})
                        ann_id += 1
            if fmt == "yolo_labels":
                archive.writestr("classes.txt", "\n".join(project["classes"]) + ("\n" if project["classes"] else ""))
            elif fmt == "yolo":
                archive.writestr("classes.txt", "\n".join(project["classes"]) + "\n")
                archive.writestr("data.yaml", "path: .\ntrain: images\nval: images\nnames:\n" +
                                 "".join(f"  {i}: {json.dumps(name, ensure_ascii=False)}\n" for i, name in enumerate(project["classes"])))
            elif fmt == "coco":
                coco = {"images": coco_images, "annotations": coco_annotations,
                        "categories": [{"id": i + 1, "name": name, "supercategory": "object"} for i, name in enumerate(project["classes"])]}
                archive.writestr("annotations/instances.json", json.dumps(coco, ensure_ascii=False, indent=2))
        memory.seek(0)
        return send_file(memory, mimetype="application/zip", as_attachment=True,
                         download_name=f"{secure_filename(project['name']) or 'dataset'}_{fmt}.zip")
    except (FileNotFoundError, ValueError) as exc:
        return error(str(exc), 404)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
