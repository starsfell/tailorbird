"""Find visually similar photos across the entire folder, ignoring time.

Useful for "I shot a bird, did other things, then came back and shot the same
bird again" — the burst clusterer won't link those, but pHash will.
"""
from __future__ import annotations

from app.core.hashing import hamming
from app.db.schema import tx


def find_similar_groups(folder_id: int, threshold: int = 16) -> list[dict]:
    """Group photos by pHash similarity using union-find. Operates at the SHOT
    level (one entry per stem) so ARW+HIF pairs are treated as a single unit.

    Args:
        folder_id: folder primary key
        threshold: max Hamming distance (out of 256 bits for 16x16 pHash)
                   16 ≈ "same scene / very similar"; 24 ≈ "same subject"

    Returns:
        List of groups (size >= 2), each containing the participating shots,
        sorted by group size desc.
    """
    with tx() as conn:
        # Pick one representative phash per stem; prefer ARW (richest preview).
        rows = conn.execute(
            """
            SELECT stem, MIN(shot_at) AS shot_at,
                   GROUP_CONCAT(id) AS member_ids,
                   GROUP_CONCAT(ext) AS exts,
                   GROUP_CONCAT(phash) AS phashes,
                   MAX(subject_sharpness) AS subj_sharp,
                   MAX(eye_sharpness) AS eye_sharp,
                   MAX(aesthetic_score) AS aes,
                   MAX(bird_confidence) AS conf,
                   MAX(rating) AS rating,
                   MAX(pick) AS pick,
                   MAX(is_flying) AS is_flying,
                   MAX(is_over) AS is_over,
                   MAX(is_under) AS is_under,
                   MAX(focus_weight) AS focus_weight,
                   MAX(eye_visibility) AS eye_visibility,
                   MAX(cluster_id) AS cluster_id,
                   MAX(is_cluster_best) AS is_cluster_best
            FROM photos
            WHERE folder_id=? AND deleted_at IS NULL AND phash IS NOT NULL
            GROUP BY stem
            ORDER BY shot_at IS NULL, shot_at
            """,
            (folder_id,),
        ).fetchall()

    shots: list[dict] = []
    for r in rows:
        d = dict(r)
        member_ids = [int(x) for x in d["member_ids"].split(",")]
        exts = d["exts"].split(",")
        phashes = d["phashes"].split(",")
        order = {".arw": 0, ".nef": 0, ".cr3": 0, ".cr2": 0, ".raf": 0, ".orf": 0, ".rw2": 0,
                 ".hif": 1, ".heif": 1, ".heic": 1, ".jpg": 2, ".jpeg": 2}
        triples = sorted(zip(exts, member_ids, phashes), key=lambda t: order.get(t[0], 9))
        primary_id = triples[0][1]
        rep_phash = triples[0][2]
        d["primary_id"] = primary_id
        d["phash"] = rep_phash
        d["member_ids_list"] = member_ids
        d["exts_list"] = exts
        shots.append(d)

    n = len(shots)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if hamming(shots[i]["phash"], shots[j]["phash"]) <= threshold:
                union(i, j)

    buckets: dict[int, list[dict]] = {}
    for i in range(n):
        buckets.setdefault(find(i), []).append(shots[i])

    groups: list[dict] = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda s: -((s.get("eye_sharp") or s.get("subj_sharp") or 0)))
        groups.append({"size": len(members), "shots": members})

    groups.sort(key=lambda g: -g["size"])
    return groups
