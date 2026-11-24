'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const infoagent = require('../lib/infoagent');

test('infoagent isConfigured checks credentials presence', () => {
  const origId = process.env.INFOAGENT_CLIENT_ID;
  const origSecret = process.env.INFOAGENT_CLIENT_SECRET;

  try {
    delete process.env.INFOAGENT_CLIENT_ID;
    delete process.env.INFOAGENT_CLIENT_SECRET;
    assert.equal(infoagent.isConfigured(), false);

    process.env.INFOAGENT_CLIENT_ID = 'test-id';
    process.env.INFOAGENT_CLIENT_SECRET = 'test-secret';
    assert.equal(infoagent.isConfigured(), true);
  } finally {
    if (origId !== undefined) process.env.INFOAGENT_CLIENT_ID = origId;
    else delete process.env.INFOAGENT_CLIENT_ID;
    if (origSecret !== undefined) process.env.INFOAGENT_CLIENT_SECRET = origSecret;
    else delete process.env.INFOAGENT_CLIENT_SECRET;
  }
});

test('infoagent normalizeResponse parses clean NEVDIS payload correctly', () => {
  const mockPayload = {
    result: {
      responseCode: 'SUCCESS',
      vehicles: [
        {
          identification: {
            plate: 'TEST01',
            state: 'VIC',
            vin: '6T9P01V97PANA4001'
          },
          extendedData: {
            makeDescription: 'FORD',
            modelDescription: 'TEST',
            bodyType: 'SEDAN',
            colour: 'WHITE',
            engineNumber: 'ENG123456'
          },
          vehicleAge: {
            yearOfManufacture: 2023,
            compliancePlate: '03/2023'
          },
          registration: {
            status: 'REGISTERED',
            expiryDate: '2027-03-13'
          },
          stolenInfo: {
            isStolen: false,
            incidents: []
          },
          writtenOffInfo: {
            isWrittenOff: false,
            incidents: []
          }
        }
      ]
    }
  };

  const normalized = infoagent.normalizeResponse(mockPayload, 'TEST01', 'VIC');
  assert.equal(normalized.rego, 'TEST01');
  assert.equal(normalized.state, 'VIC');
  assert.equal(normalized.vin, '6T9P01V97PANA4001');
  assert.equal(normalized.make, 'FORD');
  assert.equal(normalized.model, 'TEST');
  assert.equal(normalized.year, 2023);
  assert.equal(normalized.bodyType, 'SEDAN');
  assert.equal(normalized.colour, 'WHITE');
  assert.equal(normalized.engineNumber, 'ENG123456');
  assert.equal(normalized.registration.status, 'REGISTERED');
  assert.equal(normalized.registration.expiryDate, '2027-03-13');
  assert.equal(normalized.riskFlags.isStolen, false);
  assert.equal(normalized.riskFlags.isWrittenOff, false);
  assert.equal(normalized.warnings.length, 0);
  assert.equal(normalized.source, 'InfoAgent NEVDIS');
});

test('infoagent normalizeResponse flags stolen and written-off risks', () => {
  const riskyPayload = {
    result: {
      responseCode: 'SUCCESS',
      vehicles: [
        {
          identification: {
            plate: 'STOLEN1',
            state: 'NSW',
            vin: 'JTEBR3FJX0K101854'
          },
          extendedData: {
            makeDescription: 'TOYOTA',
            modelDescription: 'RAV4'
          },
          vehicleAge: {
            yearOfManufacture: 2020
          },
          registration: {
            status: 'EXPIRED',
            expiryDate: '2022-01-01'
          },
          stolenInfo: {
            isStolen: true,
            incidents: [{ jurisdiction: 'NSW', incidentDate: '2023-05-10' }]
          },
          writtenOffInfo: {
            isWrittenOff: true,
            incidents: [{ writtenOffCode: 'STATUTORY', jurisdiction: 'NSW' }]
          }
        }
      ]
    }
  };

  const normalized = infoagent.normalizeResponse(riskyPayload, 'STOLEN1', 'NSW');
  assert.equal(normalized.riskFlags.isStolen, true);
  assert.equal(normalized.riskFlags.isWrittenOff, true);
  assert.equal(normalized.registration.status, 'EXPIRED');
  assert.ok(normalized.warnings.some(w => w.includes('WRITTEN-OFF ALERT')));
  assert.ok(normalized.warnings.some(w => w.includes('POLICE STOLEN ALERT')));
  assert.ok(normalized.warnings.some(w => w.includes('REGISTRATION ALERT')));
});

test('infoagent normalizeResponse returns null on non-success or empty payloads', () => {
  assert.equal(infoagent.normalizeResponse(null), null);
  assert.equal(infoagent.normalizeResponse({ result: { responseCode: 'VEHICLE_NOT_FOUND' } }), null);
  assert.equal(infoagent.normalizeResponse({ result: { responseCode: 'SUCCESS', vehicles: [] } }), null);
});
