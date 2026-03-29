#!/usr/bin/env python3
"""
Storage restore helper — uploads files from a backup's storage/ folder
to a Supabase project's storage buckets.

Usage: python3 restore_storage.py <storage_dir> <supabase_url> <service_role_key>
"""

import sys
import os
import json
import mimetypes
import httpx

def upload_file(client, supabase_url, service_role_key, bucket, path, file_path):
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type:
        mime_type = "application/octet-stream"

    with open(file_path, "rb") as f:
        data = f.read()

    url = f"{supabase_url}/storage/v1/object/{bucket}/{path}"
    headers = {
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": mime_type,
        "x-upsert": "true",  # overwrite if exists
    }
    response = client.post(url, content=data, headers=headers)
    response.raise_for_status()
    return len(data)

def main():
    if len(sys.argv) != 4:
        print("Usage: restore_storage.py <storage_dir> <supabase_url> <service_role_key>")
        sys.exit(1)

    storage_dir = sys.argv[1]
    supabase_url = sys.argv[2].rstrip("/")
    service_role_key = sys.argv[3]

    manifest_path = os.path.join(storage_dir, "_manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)

    total_uploaded = 0
    total_bytes = 0

    with httpx.Client(timeout=60.0) as client:
        for bucket_entry in manifest:
            bucket = bucket_entry["bucket"]
            files = bucket_entry["files"]

            if not files:
                print(f"  {bucket}: (empty, skipping)")
                continue

            print(f"  {bucket}: uploading {len(files)} files...")
            bucket_dir = os.path.join(storage_dir, bucket)
            uploaded = 0

            for file_path in files:
                local_path = os.path.join(bucket_dir, file_path)
                if not os.path.exists(local_path):
                    print(f"    ⚠️  Missing: {file_path}")
                    continue
                try:
                    nbytes = upload_file(client, supabase_url, service_role_key, bucket, file_path, local_path)
                    total_bytes += nbytes
                    uploaded += 1
                    total_uploaded += 1
                except httpx.HTTPStatusError as e:
                    print(f"    ❌ Failed {file_path}: {e.response.status_code} {e.response.text[:100]}")
                except Exception as e:
                    print(f"    ❌ Error {file_path}: {e}")

            print(f"    ✓ {uploaded}/{len(files)} uploaded")

    print(f"  Storage total: {total_uploaded} files, {total_bytes/1024:.0f} KB")

if __name__ == "__main__":
    main()
