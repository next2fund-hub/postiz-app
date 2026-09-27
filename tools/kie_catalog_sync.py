#!/usr/bin/env python3
"""
kie_catalog_sync.py - regenerate the Studio's kie.ai model catalog from kie.ai's
own documentation.

WHY THIS EXISTS

kie.ai sells well over a hundred image and video models through a single
endpoint, switched by a `model` string, and publishes no machine-readable model
index. Hand-maintaining that list is a losing game: it is long, it changes, and
kie.ai IGNORES UNKNOWN INPUT KEYS SILENTLY - so a mistyped parameter name does
not raise, it just produces a generation that quietly dropped your setting.

But each docs page embeds a full OpenAPI 3.0.1 spec in a ```yaml block, which
IS machine-readable. So we read the spec rather than the prose, and generate the
catalog. Wrong-by-typo becomes impossible; the only failure mode left is kie.ai
documenting something incorrectly.

USAGE
    python tools/kie_catalog_sync.py            # rewrite the catalog in place
    python tools/kie_catalog_sync.py --dry-run  # print a summary only

Re-run it when kie.ai adds models. Review the diff before committing - this
generates code that ships to production.
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

LLMS = "https://docs.kie.ai/llms.txt"
OUT = (
    Path(__file__).resolve().parents[1]
    / "libraries/nestjs-libraries/src/studio/catalog/kie.catalog.ts"
)
UA = "Mozilla/5.0 (compatible; postiz-studio-catalog-sync)"

# Only generation models belong in the Studio. Everything else kie.ai sells -
# chat completions, speech, upscalers, background removal - is a different
# product surface and would just clutter the picker.
CATEGORY_CAPABILITY = {
    "Image Models": "image",
    "Video Models": "video",
}

# Parameters the Studio supplies itself, or that make no sense in a form.
SKIP_FIELDS = {"model", "callBackUrl", "callbackUrl"}

# The vertical/horizontal toggle owns this one.
ASPECT_FIELD = "aspect_ratio"

VERTICAL_PREFS = ["9:16", "3:4", "2:3", "4:5"]
HORIZONTAL_PREFS = ["16:9", "4:3", "3:2", "5:4", "21:9"]


CACHE = Path(__file__).resolve().parent / ".kie-docs-cache"


def fetch(url: str, use_cache: bool = True) -> str:
    """
    Fetch a docs page, with retries and an on-disk cache.

    Both matter. Fetching ~180 pages concurrently gets throttled, and a
    throttled response is not an error here - it is an HTML error page with no
    OpenAPI block, which the parser reports as "this model has no spec". That
    failure mode silently shrinks the catalog instead of announcing itself, so
    retry hard and cache what succeeds.
    """
    if use_cache:
        CACHE.mkdir(exist_ok=True)
        key = CACHE / (re.sub(r"[^a-z0-9]+", "_", url.lower()).strip("_") + ".md")
        if key.exists() and key.stat().st_size > 0:
            return key.read_text(encoding="utf-8")

    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read().decode("utf-8", errors="replace")
            if "```yaml" in body or url.endswith("llms.txt"):
                if use_cache:
                    key.write_text(body, encoding="utf-8")
                return body
            last = "no yaml block in response"
        except Exception as e:  # noqa: BLE001 - any transport error is retryable
            last = str(e)
        time.sleep(1.5 * (attempt + 1))

    raise RuntimeError(last or "unknown fetch failure")


def model_urls() -> list:
    text = fetch(LLMS, use_cache=False)
    urls = sorted(set(re.findall(r"https://docs\.kie\.ai/market/[a-z0-9._/-]+", text)))
    # quickstart and the shared task-status page are not models
    return [u for u in urls if not u.endswith(("quickstart.md", "get-task-detail.md"))]


def extract_spec(md: str):
    """Pull the OpenAPI YAML block out of a docs page."""
    m = re.search(r"```yaml\n(.*?)\n```", md, re.S)
    if not m:
        return None
    try:
        return yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None


def post_op(spec):
    try:
        return spec["paths"]["/api/v1/jobs/createTask"]["post"]
    except (KeyError, TypeError):
        return None


def category_of(op) -> str:
    """
    tags look like 'docs/en/Market/Video Models/Kling'.

    Note the whitespace collapse: image pages are tagged 'Image    Models' with
    several spaces, video pages with one. An exact match silently yields zero
    image models, which looks exactly like "kie.ai has no image models".
    """
    for tag in op.get("tags") or []:
        for part in str(tag).split("/"):
            if re.sub(r"\s+", " ", part).strip() in CATEGORY_CAPABILITY:
                return re.sub(r"\s+", " ", part).strip()
    return ""


def vendor_of(op, url: str) -> str:
    for tag in op.get("tags") or []:
        parts = [p for p in str(tag).split("/") if p]
        if len(parts) >= 1 and parts[-1] not in CATEGORY_CAPABILITY:
            return parts[-1]
    # fall back to the URL segment after /market/
    seg = url.split("/market/")[-1].split("/")
    return seg[0].replace(".md", "") if seg else "kie"


def schema_of(op):
    try:
        return op["requestBody"]["content"]["application/json"]["schema"]["properties"]
    except (KeyError, TypeError):
        return {}


def model_string(props):
    m = props.get("model") or {}
    if m.get("enum"):
        return str(m["enum"][0])
    if m.get("default"):
        return str(m["default"])
    return None


def clean(text, limit=160) -> str:
    if not text:
        return ""
    text = re.sub(r"\s+", " ", str(text)).strip()
    text = re.sub(r"[`*<>]", "", text)
    # docs descriptions often carry a long bulleted tail; keep the first sentence
    first = re.split(r"(?<=[.!?]) ", text)[0]
    out = first if len(first) >= 20 else text
    return (out[: limit - 1] + "…") if len(out) > limit else out


# Titlecasing the API field name gives "Input Urls", "Nsfw Checker",
# "Camera Fixed" - which reads as a dump of someone else's API, because it is.
# These are the ones users actually see, so they get written by hand.
LABEL_OVERRIDES = {
    "prompt": "Prompt",
    "negative_prompt": "Avoid",
    "image_urls": "Source image",
    "input_urls": "Reference images",
    "image_input": "Reference images",
    "image_url": "Source image",
    "reference_images": "Reference images",
    "video_url": "Source video",
    "first_frame": "First frame",
    "last_frame": "Last frame",
    "duration": "Duration",
    "resolution": "Resolution",
    "output_format": "File format",
    "sound": "Generate audio",
    "seed": "Seed",
    "camera_fixed": "Lock the camera",
    "nsfw_checker": "Filter explicit results",
    "enable_safety_checker": "Safety filter",
    "enable_prompt_expansion": "Expand my prompt",
    "expand_prompt": "Expand my prompt",
    "num_images": "How many",
    "n": "How many",
    "style": "Style",
    "quality": "Quality",
}


def label_of(name: str) -> str:
    if name in LABEL_OVERRIDES:
        return LABEL_OVERRIDES[name]
    words = name.replace("_", " ").replace("-", " ").split()
    return " ".join(w if w.isupper() else w.capitalize() for w in words) or name


def build_field(name, spec, required):
    """Map one OpenAPI property onto a StudioParamField."""
    if name in SKIP_FIELDS or name == ASPECT_FIELD:
        return None
    if not isinstance(spec, dict):
        return None

    t = spec.get("type")
    desc = clean(spec.get("description"), 120)
    field = {"name": name, "label": label_of(name)}
    if desc:
        field["description"] = desc
    if required:
        field["required"] = True

    enum = spec.get("enum")
    if enum:
        field["type"] = "select"
        field["options"] = [{"value": str(v), "label": str(v)} for v in enum]
        if spec.get("default") is not None:
            field["default"] = str(spec["default"])
        if t in ("integer", "number"):
            field["coerce"] = "number"
        return field

    if t == "boolean":
        field["type"] = "boolean"
        if spec.get("default") is not None:
            field["default"] = bool(spec["default"])
        return field

    if t in ("integer", "number"):
        field["type"] = "number"
        for a, b in (("minimum", "min"), ("maximum", "max")):
            if spec.get(a) is not None:
                field[b] = spec[a]
        if spec.get("default") is not None:
            field["default"] = spec["default"]
        return field

    if t == "array":
        items = spec.get("items") or {}
        if items.get("type") == "string":
            field["type"] = "media"
            field["accept"] = "video" if "video" in name else "image"
            if spec.get("maxItems"):
                field["max"] = spec["maxItems"]
            return field
        return None

    if t == "string":
        maxlen = spec.get("maxLength")
        field["type"] = (
            "textarea" if name == "prompt" or (maxlen or 0) > 300 else "text"
        )
        if maxlen:
            field["maxLength"] = maxlen
        if spec.get("default") is not None:
            field["default"] = str(spec["default"])
        return field

    return None


def aspect_of(props):
    """Map our vertical/horizontal toggle onto the model's own ratios."""
    spec = props.get("input", {}).get("properties", {}).get(ASPECT_FIELD)
    if not isinstance(spec, dict):
        return None
    enum = [str(v) for v in (spec.get("enum") or [])]
    if not enum:
        return None
    vertical = next((v for v in VERTICAL_PREFS if v in enum), None)
    horizontal = next((h for h in HORIZONTAL_PREFS if h in enum), None)
    if not vertical or not horizontal:
        return None
    return {"field": ASPECT_FIELD, "vertical": vertical, "horizontal": horizontal}


def mode_of(model: str, url: str, capability: str) -> str:
    hay = f"{model} {url}".lower()
    if "image-to-video" in hay or "img2video" in hay:
        return "image-to-video"
    if "text-to-video" in hay:
        return "text-to-video"
    if "image-to-image" in hay or "edit" in hay or "remix" in hay:
        return "image-to-image"
    if "text-to-image" in hay:
        return "text-to-image"
    return "text-to-video" if capability == "video" else "text-to-image"


def parse(url: str):
    try:
        md = fetch(url)
    except Exception as e:
        return {"url": url, "error": f"fetch failed: {e}"}

    spec = extract_spec(md)
    if not spec:
        return {"url": url, "error": "no OpenAPI block"}
    op = post_op(spec)
    if not op:
        return {"url": url, "error": "not a createTask model"}

    category = category_of(op)
    capability = CATEGORY_CAPABILITY.get(category)
    if not capability:
        return {"url": url, "skip": True}

    props = schema_of(op)
    model = model_string(props)
    if not model:
        return {"url": url, "error": "no model string"}

    input_schema = props.get("input") or {}
    input_props = input_schema.get("properties") or {}
    required = set(input_schema.get("required") or [])

    fields = []
    for name, fspec in input_props.items():
        f = build_field(name, fspec, name in required)
        if f:
            fields.append(f)
    if not fields:
        return {"url": url, "error": "no usable input fields"}

    # Prompt first; it is what people type.
    fields.sort(key=lambda f: (f["name"] != "prompt", not f.get("required")))

    title = clean(op.get("summary") or model, 60)
    return {
        "id": f"kie:{model}",
        "provider": "kie",
        "providerModel": model,
        "title": title,
        "description": clean(op.get("summary"), 110) or title,
        "capability": capability,
        "mode": mode_of(model, url, capability),
        "vendor": vendor_of(op, url),
        "docs": url[:-3] if url.endswith(".md") else url,
        "fields": fields,
        "aspect": aspect_of(props),
    }


def ts_value(v, indent=0):
    pad = "  " * indent
    if isinstance(v, dict):
        inner = "".join(
            f"{pad}  {k}: {ts_value(val, indent + 1)},\n"
            for k, val in v.items()
            if val is not None
        )
        return "{\n" + inner + pad + "}"
    if isinstance(v, list):
        inner = "".join(f"{pad}  {ts_value(i, indent + 1)},\n" for i in v)
        return "[\n" + inner + pad + "]"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(str(v))


HEADER = '''import { StudioModel } from '@gitroom/nestjs-libraries/studio/studio.types';

/**
 * kie.ai model catalog - GENERATED. Do not edit by hand.
 *
 * Regenerate with:
 *     python tools/kie_catalog_sync.py
 *
 * Source: the OpenAPI spec embedded in each page under
 * https://docs.kie.ai/market/, discovered via https://docs.kie.ai/llms.txt.
 *
 * Generated rather than written because kie.ai ignores unknown input keys
 * SILENTLY - a mistyped parameter name does not raise, it produces a generation
 * that quietly dropped the setting. Reading the spec removes that whole class
 * of bug.
 *
 * `aspect_ratio` is deliberately absent from every field list: the Studio's
 * vertical/horizontal toggle owns it, via each model's `aspect` mapping.
 *
 * %d models: %d image, %d video.
 */
export const KIE_MODELS: StudioModel[] = '''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    urls = model_urls()
    print(f"{len(urls)} candidate pages", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(parse, urls))

    models, errors, skipped = [], [], 0
    for r in results:
        if r.get("skip"):
            skipped += 1
        elif r.get("error"):
            errors.append(r)
        else:
            models.append(r)

    models.sort(key=lambda m: (m["capability"], m["vendor"].lower(), m["title"].lower()))

    images = sum(1 for m in models if m["capability"] == "image")
    videos = len(models) - images
    print(
        f"{len(models)} models ({images} image, {videos} video); "
        f"{skipped} non-generation pages skipped; {len(errors)} unparsed",
        file=sys.stderr,
    )
    for e in errors[:15]:
        print(f"  unparsed: {e['url']} - {e['error']}", file=sys.stderr)

    if args.dry_run:
        return

    body = ts_value(models)
    OUT.write_text(
        (HEADER % (len(models), images, videos)) + body + ";\n", encoding="utf-8"
    )
    print(f"wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
