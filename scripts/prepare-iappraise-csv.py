#!/usr/bin/env python3
"""Preserve every row of an official iAppraise CSV in a migration bundle.

Usage: python3 scripts/prepare-iappraise-csv.py INPUT.csv OUTPUT_DIRECTORY
CSV has no upstream appraisal IDs. Identities therefore identify rows within
the exact exported snapshot; they must not be used to merge customer records.
Photos, videos and partner contact data absent from the CSV remain missing.
"""
import argparse
import collections
import csv
import hashlib
import json
import os
from pathlib import Path

SITES = {
    'Kia NEW': 'South Morang Kia', 'Kia USED': 'South Morang Kia',
    'Hyundai NEW': 'South Morang Hyundai', 'Hyundai USED': 'South Morang Hyundai',
    'BYD': 'BYD South Morang', 'Chery NEW': 'Chery South Morang',
}


def prepare(source, target):
    original = source.read_bytes()
    fingerprint = hashlib.sha256(original).hexdigest()
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    (target / 'records').mkdir(mode=0o700)
    (target / 'source.csv').write_bytes(original)
    os.chmod(target / 'source.csv', 0o600)
    records = []
    sites = collections.Counter()
    unclassified = 0
    with source.open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        if len(set(headers)) != len(headers) or not {'Dealership', 'Department', 'Rego', 'VIN'}.issubset(headers):
            raise ValueError('Export has missing or duplicate headers; inspect its schema first.')
        for number, row in enumerate(reader, 1):
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f'Malformed CSV row {number}; nothing should be imported.')
            if row['Dealership'] != 'South Morang Kia, Hyundai & BYD':
                raise ValueError('Source dealership is not mapped. Define an explicit approved mapping.')
            site = SITES.get(row['Department'], 'South Morang Kia, Hyundai & BYD')
            if site == 'South Morang Kia, Hyundai & BYD':
                unclassified += 1
            sites[site] += 1
            # Preserve blanks, repeated rows and every original header verbatim.
            data = json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf8')
            relative = f'records/{number:06d}.json'
            file = target / relative
            file.write_bytes(data)
            os.chmod(file, 0o600)
            records.append({'kind': 'appraisal', 'sourceId': f'csv:{fingerprint}:row:{number}',
                            'dealership': site, 'dataPath': relative,
                            'sha256': hashlib.sha256(data).hexdigest(), 'media': []})
    manifest = {'version': 1, 'source': 'official-iappraise-csv', 'expectedRecords': len(records),
                'expectedCounts': {'appraisal': len(records), 'dealer': 0, 'wholesaler': 0},
                'sourceFiles': [{'path': 'source.csv', 'sha256': fingerprint, 'size': len(original)}],
                'limitations': ['CSV row identities are not upstream appraisal IDs.',
                                'CSV does not contain all appraisal details, photos, videos or wholesaler contacts.',
                                'Unclassified departments are manager-only group archive records.'],
                'records': records}
    filename = target / 'manifest.json'
    filename.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    os.chmod(filename, 0o600)
    return {'records': len(records), 'sites': dict(sites), 'unclassifiedDepartments': unclassified,
            'sourceSha256': fingerprint, 'completeSourceVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.target), indent=2))
