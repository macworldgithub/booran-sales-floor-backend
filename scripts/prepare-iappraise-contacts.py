#!/usr/bin/env python3
"""Build an import bundle from the exact DOM-extracted Permissions directory.

Usage: python3 scripts/prepare-iappraise-contacts.py contacts.json OUTPUT_DIR
Imports contacts only. Never creates Sales Floor users or grants permissions.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path


def prepare(source, target):
    original = source.read_bytes()
    snapshot = json.loads(original)
    if snapshot.get('sourceUrl') != 'https://www.iappraise.net.au/permissions':
        raise ValueError('Unsupported directory source.')
    if snapshot.get('sourceDealership') != 'South Morang Kia, Hyundai & BYD':
        raise ValueError('Source dealership is not mapped.')
    rows = snapshot.get('rows')
    if not isinstance(rows, list) or len(rows) != snapshot.get('sourceRowCount'):
        raise ValueError('Directory row count mismatch.')
    if snapshot.get('columns') != ['User Name', 'Email', 'Phone Number', 'User Role']:
        raise ValueError('Unexpected source directory columns.')
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    (target / 'records').mkdir(mode=0o700)
    (target / 'source.json').write_bytes(original)
    os.chmod(target / 'source.json', 0o600)
    records = []
    seen = set()
    for index, values in enumerate(rows, 1):
        if len(values) != 4 or any(not isinstance(value, str) for value in values):
            raise ValueError('Invalid contact row.')
        raw = dict(zip(snapshot['columns'], values))
        raw['Dealership'] = snapshot['sourceDealership']
        raw['Can Request PPSR'] = snapshot['canRequestPPSR']
        payload = json.dumps(raw, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        name, email, phone, role = values
        source_id = 'permissions:' + hashlib.sha256(json.dumps([name, email], ensure_ascii=False).encode('utf8')).hexdigest()
        if source_id in seen:
            raise ValueError('Repeated contact identity requires manual mapping.')
        seen.add(source_id)
        relative = f'records/{index:04d}.json'
        (target / relative).write_bytes(payload)
        os.chmod(target / relative, 0o600)
        records.append({'kind': 'dealer', 'dealership': 'South Morang Kia, Hyundai & BYD', 'sourceId': source_id,
                        'dataPath': relative, 'sha256': hashlib.sha256(payload).hexdigest(), 'media': [],
                        'partner': {'name': name, 'company': raw['Dealership'], 'email': email, 'phone': phone,
                                    'notes': f'Dealer staff contact imported from iAppraise Permissions. Source role: {role}.', 'active': True}})
    manifest = {'version': 1, 'source': snapshot['sourceUrl'], 'expectedRecords': len(records),
                'expectedCounts': {'appraisal': 0, 'dealer': len(records), 'wholesaler': 0},
                'sourceFiles': [{'path': 'source.json', 'sha256': hashlib.sha256(original).hexdigest(), 'size': len(original)}],
                'records': records}
    (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    os.chmod(target / 'manifest.json', 0o600)
    return {'dealerContacts': len(records), 'wholesalerContacts': 0, 'accountsCreated': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.target), indent=2))
