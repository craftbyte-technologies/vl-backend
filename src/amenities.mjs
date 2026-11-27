import definition from './amenities.json' with {type:'json'};
import {requireValue, text} from './database.mjs';

const entries = definition.entries.map(entry => ({...entry, active:true, aliases:[]}));
const byId = new Map(entries.map(entry => [entry.id, entry]));
const byName = new Map(entries.map(entry => [entry.name, entry.id]));
for (const [name, id] of Object.entries(definition.legacyNames)) byName.set(name, id);
const states = ['Available', 'Unavailable', 'Unknown'];
const parkingOptions = {cover:['Covered', 'Open'], allocation:['Assigned', 'Shared'], billing:['Included', 'One-time fee', 'Recurring fee']};

export async function catalogue(db) {
  const aliases = new Map();
  const legacy = [];
  for (const row of await db.find('amenities', {}, {name:1})) {
    const entry = byId.get(byName.get(row.name));
    const types = JSON.parse(row.types_json);
    if (entry && types.every(type=>entry.types.includes(type))) {
      const id = row.name === 'Covered parking' ? 'covered-parking' : entry.id;
      if (!aliases.has(id)) aliases.set(id, []);
      aliases.get(id).push(row.id);
    } else {
      legacy.push({id:row.id, name:row.name, types, group:'Previous catalogue', icon:'List', fields:[], active:false, aliases:[]});
    }
  }
  const cover = {id:'covered-parking', name:'Covered parking', types:byId.get('car-parking').types,
    group:'Parking & accessibility', icon:'CarFront', fields:[], active:false, aliases:aliases.get('covered-parking') || []};
  return [...entries.map(entry => ({...entry, aliases:aliases.get(entry.id) || []})), cover, ...legacy];
}

export async function propertyAmenities(db, propertyId, catalog) {
  const lookup = new Map(catalog.flatMap(entry => [entry.id, ...entry.aliases].map(id => [id, entry])));
  const result = new Map();
  for (const row of await db.find('property_amenities', {property_id:propertyId})) {
    const source = lookup.get(row.amenity_id);
    if (!source) continue;
    const covered = source.id === 'covered-parking';
    const entry = covered ? byId.get('car-parking') : source;
    const values = covered && row.state === 'Available' ? {parking:[{cover:'Covered'}]} : row.values;
    // A typed assignment takes priority over an older assignment for the same facility.
    if (!result.has(entry.id) || row.amenity_id === entry.id) {
      result.set(entry.id, {id:entry.id, name:entry.name, state:row.state, detail:row.detail || '', values});
    }
  }
  return [...result.values()];
}

function number(value, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000 && (!integer || Number.isInteger(value));
}

function validateParking(value, label) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 12, `Add up to 12 ${label} allocations.`);
  return value.map(row => {
    requireValue(row && typeof row === 'object' && !Array.isArray(row), `Invalid ${label} allocation.`);
    const entry = {};
    for (const [key, field] of Object.entries(row)) {
      if (key === 'count' || key === 'fee') {
        requireValue(number(field, key === 'count'), `Enter a valid ${label} ${key}.`);
      } else {
        requireValue(Object.hasOwn(parkingOptions, key) && parkingOptions[key].includes(field), `Choose a valid ${label} option.`);
      }
      entry[key] = field;
    }
    requireValue(Object.keys(entry).length > 0 && (!entry.fee || ['One-time fee','Recurring fee'].includes(entry.billing)), `Choose a billing period for ${label} fees.`);
    return entry;
  });
}

function validateValues(entry, input = {}) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), `Invalid details for ${entry.name}.`);
  const values = {};
  for (const [key, value] of Object.entries(input)) {
    requireValue(entry.fields.includes(key), `That detail does not apply to ${entry.name}.`);
    const field = definition.fields[key];
    if (field.parking) values[key] = validateParking(value, entry.name);
    else if (field.multiple) {
      requireValue(Array.isArray(value) && value.length > 0 && value.length <= field.options.length && value.every(option => field.options.includes(option)), `Choose valid values for ${field.label.toLowerCase()}.`);
      values[key] = [...new Set(value)];
    } else if (field.options) {
      requireValue(field.options.includes(value), `Choose a valid option for ${field.label.toLowerCase()}.`);
      values[key] = value;
    } else if (field.unit !== undefined) {
      requireValue(number(value, field.integer), `Enter a valid ${field.label.toLowerCase()} for ${entry.name}.`);
      values[key] = value;
    } else {
      requireValue(typeof value === 'string' && value.length <= 160, `Use up to 160 characters for ${field.label.toLowerCase()}.`);
      if (value.trim()) values[key] = value.trim();
    }
  }
  if (values.width) requireValue(values.roadUnit, 'Choose the road width unit.');
  return values;
}

export function validateAmenities(input, catalog, {type, existing = [], project = false} = {}) {
  requireValue(Array.isArray(input) && input.length <= catalog.length, 'Invalid amenity assignments.');
  const previous = new Map(existing.map(entry => [entry.id, entry]));
  const seen = new Set();
  return input.map(assignment => {
    requireValue(assignment && typeof assignment === 'object', 'Invalid amenity assignment.');
    const id = assignment.id || byName.get(assignment.name) || catalog.find(entry => entry.name === assignment.name)?.id;
    const entry = catalog.find(candidate => candidate.id === id);
    requireValue(entry && !seen.has(id) && (project ? entry.project : entry.types.includes(type)), `Amenity not applicable: ${text(assignment.name,80)}`);
    seen.add(id);
    if (!entry.active) {
      const legacy = previous.get(id);
      requireValue(legacy && legacy.state === assignment.state && legacy.detail === assignment.detail, 'Previous catalogue entries are read-only.');
      return {...legacy};
    }
    requireValue([...states, ...(project ? ['Planned'] : [])].includes(assignment.state), 'Choose an amenity status.');
    const legacyCovered = !assignment.id && assignment.name === 'Covered parking' && assignment.state === 'Available';
    const values = validateValues(entry, assignment.values ?? (legacyCovered ? {parking:[{cover:'Covered'}]} : {}));
    return {id, name:entry.name, state:assignment.state, detail:text(assignment.detail,300), values};
  });
}

export function sharedAmenities(project, access) {
  return (project?.amenities || []).filter(entry =>
    entry.state === 'Available' && ['Confirmed','Restricted'].includes(access?.[entry.id])
  ).map(entry => ({...entry, scope:'Project', entitlement:access[entry.id]}));
}

export function validateProjectAccess(input, project, previous, type) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Invalid project amenity access.');
  return Object.fromEntries(Object.entries(input).filter(([id, access]) => {
    const definition = byId.get(id);
    requireValue(definition?.project && definition.types.includes(type) && ['Confirmed','Restricted'].includes(access), 'Invalid project amenity access.');
    return project?.amenities?.some(entry => entry.id === id) || previous?.[id] === access;
  }));
}

const variants = {
  'covered-parking': {base:'car-parking', match:{'values.parking.cover':'Covered'}},
  'assigned-covered-parking': {base:'car-parking', match:{'values.parking':{$elemMatch:{cover:'Covered', allocation:'Assigned'}}}},
  'installed-ev-charging': {base:'ev-charging', match:{'values.installation':'Installed'}},
  'unit-power-backup': {base:'power-backup', match:{'values.coverage':{$in:['Selected unit circuits','Whole unit']}}},
  'two-passenger-lifts': {base:'passenger-lift', match:{'values.count':{$gte:2}}}
};

export function amenityMatch(catalog, id) {
  const requested = catalog.find(entry => entry.id === id || entry.aliases.includes(id));
  const canonical = requested?.id || id;
  const variant = Object.hasOwn(variants,canonical) ? variants[canonical] : undefined;
  const base = variant?.base || canonical;
  const ids = [base, ...(catalog.find(entry => entry.id === base)?.aliases || [])];
  const oldCovered = catalog.find(entry => entry.id === 'covered-parking').aliases;
  const legacyIds = ['covered-parking','car-parking'].includes(canonical) ? oldCovered : [];
  const match = variant?.match || {};
  const state = {state:'Available'};
  const conditions = [{facilities:{$elemMatch:{...state, amenity_id:{$in:ids}, ...match}}}];
  if (legacyIds.length) conditions.push({facilities:{$elemMatch:{...state, amenity_id:{$in:legacyIds}}}});
  if (byId.get(base)?.project) conditions.push({
    [`project_amenity_access.${base}`]:'Confirmed',
    'development.amenities':{$elemMatch:{...state, id:base, ...match}}
  });
  return {$or:conditions};
}
