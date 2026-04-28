#!/usr/bin/env node
// Pipeline: BDPM (DC, DCI) + Open Medic (volumes, ATC) -> data/medicaments.json
//
// Run: node scripts/build-dataset.mjs
// Env: MIN_BOITES_DC (default 50000), QUIZ_TOP_N (default 300), OPENMEDIC_YEAR (default 2024)

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE = join(HERE, '.cache');
const DATA = join(ROOT, 'data');

// Filtering happens at the DC level (after aggregating all presentations of a brand):
// MIN_BOITES_DC = minimum total boxes delivered for a normalized brand to be kept.
const MIN_BOITES_DC = Number(process.env.MIN_BOITES_DC ?? 50_000);
const QUIZ_TOP_N = Number(process.env.QUIZ_TOP_N ?? 300);
const OPENMEDIC_YEAR = Number(process.env.OPENMEDIC_YEAR ?? 2024);

const BDPM_FILES = {
  cis: 'CIS_bdpm.txt',
  compo: 'CIS_COMPO_bdpm.txt',
  cip: 'CIS_CIP_bdpm.txt',
};

mkdirSync(CACHE, { recursive: true });
mkdirSync(DATA, { recursive: true });

// ---------- helpers ----------

function log(...a) { console.log(...a); }
function warn(...a) { console.warn('  !', ...a); }

async function downloadIfMissing(url, dest, opts = {}) {
  if (existsSync(dest) && statSync(dest).size > 0 && !opts.force) {
    log(`  cache: ${dest.replace(ROOT + '/', '')}`);
    return;
  }
  log(`  GET   ${url}`);
  const res = await fetch(url, opts.fetchInit ?? {});
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function decodeLatin1(buf) {
  return new TextDecoder('latin1').decode(buf);
}

function readLatin1Lines(path) {
  const buf = readFileSync(path);
  return decodeLatin1(buf).split(/\r?\n/);
}

// ---------- 1. download BDPM ----------

async function fetchBdpm() {
  log('# BDPM');
  for (const f of Object.values(BDPM_FILES)) {
    await downloadIfMissing(
      `https://base-donnees-publique.medicaments.gouv.fr/download/file/${f}`,
      join(CACHE, f),
    );
  }
}

// ---------- 2. download Open Medic ----------

async function fetchOpenMedic(year) {
  log(`# Open Medic ${year}`);
  const csvPath = join(CACHE, `OPEN_MEDIC_${year}.CSV`);
  if (existsSync(csvPath) && statSync(csvPath).size > 0) {
    log(`  cache: ${csvPath.replace(ROOT + '/', '')}`);
    return csvPath;
  }
  // Two-step: fetch the listing HTML to extract the token URL, then download the zip.
  const listingUrl = `https://open-data-assurance-maladie.ameli.fr/medicaments/download.php?Dir_Rep=Open_MEDIC_Base_Complete&Annee=${year}`;
  const listingRes = await fetch(listingUrl);
  if (!listingRes.ok) throw new Error(`Open Medic listing ${year}: ${listingRes.status}`);
  const cookie = listingRes.headers.getSetCookie?.()?.map((c) => c.split(';')[0]).join('; ')
    ?? listingRes.headers.get('set-cookie')?.split(';')[0]
    ?? '';
  const html = await listingRes.text();
  const m = html.match(/download_file\.php\?token=[^"]+/);
  if (!m) throw new Error(`Open Medic ${year}: no download token in listing`);
  const zipUrl = `https://open-data-assurance-maladie.ameli.fr/medicaments/${m[0].replace(/&amp;/g, '&')}`;
  const zipPath = join(CACHE, `OPEN_MEDIC_${year}.zip`);
  log(`  GET   ${zipUrl}`);
  const zipRes = await fetch(zipUrl, { headers: cookie ? { cookie } : {} });
  if (!zipRes.ok) throw new Error(`Open Medic zip ${year}: ${zipRes.status}`);
  await pipeline(Readable.fromWeb(zipRes.body), createWriteStream(zipPath));
  log(`  unzip -> ${csvPath.replace(ROOT + '/', '')}`);
  const r = spawnSync('unzip', ['-o', '-d', CACHE, zipPath], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`unzip failed: ${r.status}`);
  if (!existsSync(csvPath)) throw new Error(`expected ${csvPath} after unzip`);
  return csvPath;
}

// ---------- 3. parse BDPM ----------

// CIS_bdpm.txt columns:
// 1 code CIS, 2 denomination (DC), 3 forme, 4 voies, 5 statut AMM, 6 type AMM,
// 7 etat commercialisation, 8 date AMM, 9 statut BDM, 10 num auth EU, 11 titulaire, 12 surveillance
function parseCis(path) {
  const m = new Map(); // CIS -> { dc_brut, denomination_complete }
  for (const line of readLatin1Lines(path)) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 7) continue;
    const cis = c[0].trim();
    const denomination = c[1];
    const statutAMM = c[4];
    const etatCommercialisation = c[6];
    if (statutAMM !== 'Autorisation active') continue;
    if (etatCommercialisation !== 'Commercialisée') continue;
    m.set(cis, { dc_complet: denomination });
  }
  return m;
}

// CIS_COMPO_bdpm.txt columns:
// 1 CIS, 2 designation forme, 3 code substance, 4 denomination substance (DCI), 5 dosage,
// 6 ref dosage, 7 nature composant (SA/ST), 8 num lien
function parseCompo(path) {
  const m = new Map(); // CIS -> Set<DCI>
  for (const line of readLatin1Lines(path)) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 7) continue;
    const cis = c[0].trim();
    const dci = c[3]?.trim();
    const nature = c[6]?.trim();
    if (nature !== 'SA') continue;
    if (!dci) continue;
    let s = m.get(cis);
    if (!s) { s = new Set(); m.set(cis, s); }
    s.add(dci);
  }
  return m;
}

// CIS_CIP_bdpm.txt columns:
// 1 CIS, 2 CIP7, 3 libelle, 4 statut presentation, 5 etat commercialisation, 6 date,
// 7 CIP13, 8 agrement, 9 taux, 10 prix HT, 11 prix TTC, 12 honoraire, 13 indication
function parseCip(path) {
  const m = new Map(); // CIP13 -> CIS
  for (const line of readLatin1Lines(path)) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 7) continue;
    const cis = c[0].trim();
    const cip13 = c[6]?.trim();
    if (!cip13 || !/^\d{13}$/.test(cip13)) continue;
    m.set(cip13, cis);
  }
  return m;
}

// ---------- 4. stream Open Medic, aggregate per CIP13 ----------

// CSV columns (semicolon-separated, latin-1, CRLF):
// ATC1;l_ATC1;ATC2;L_ATC2;ATC3;L_ATC3;ATC4;L_ATC4;ATC5;L_ATC5;CIP13;l_cip13;TOP_GEN;GEN_NUM;age;sexe;BEN_REG;PSP_SPE;BOITES;REM;BSE
async function aggregateOpenMedic(csvPath) {
  const perCip = new Map(); // CIP13 -> { boites, atc4, atc5, l_atc4, l_atc5, l_atc3 }
  const stream = createReadStream(csvPath).setEncoding('latin1');
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) continue; // header
    if (!line) continue;
    const c = line.split(';');
    if (c.length < 21) continue;
    const cip13 = c[10];
    if (!cip13 || !/^\d{13}$/.test(cip13)) continue;
    const boites = Number(c[18]) || 0;
    if (boites <= 0) continue;
    let entry = perCip.get(cip13);
    if (!entry) {
      entry = {
        boites: 0,
        atc4: c[6], l_atc4: c[7],
        atc5: c[8], l_atc5: c[9],
        l_atc3: c[5],
      };
      perCip.set(cip13, entry);
    }
    entry.boites += boites;
  }
  return perCip;
}

// ---------- 5. normalize DC ----------

// Examples:
//   "DOLIPRANE 1000 mg, comprimé"                                    -> "DOLIPRANE"
//   "AUGMENTIN 1 g/125 mg, poudre pour suspension buvable ..."       -> "AUGMENTIN"
//   "AUGMENTIN 100 mg/12,50 mg par ml ENFANTS, poudre ..."           -> "AUGMENTIN"
//   "LEVOTHYROX 75 MICROGRAMMES, comprimé sécable"                   -> "LEVOTHYROX"
//   "VITAMINE B12 GERDA 1000 µg/2 ml, solution injectable ..."       -> "VITAMINE B12 GERDA"
function normalizeDC(denomination) {
  if (!denomination) return '';
  let s = denomination.trim();
  // Cut at ", " (comma + space). Preserves french decimals like "12,50".
  const idx = s.indexOf(', ');
  if (idx > 0) s = s.slice(0, idx);
  // Cut at the first " <digit>" or "/<digit>" — that's where the dosage starts.
  // (A leading digit at position 0 is allowed: "5-FU EBEWE", "3 BORAX", etc.)
  s = s.replace(/[ /]\d.*$/, '');
  // Strip trailing audience/qualifier tokens.
  s = s.replace(/\s+(ADULTES?|ENFANTS?|NOURRISSONS?|B[ÉE]B[ÉE]S?|PEDIATRIQUE|SANS\s+SUCRE).*$/i, '');
  // Strip trailing parenthesised group.
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  return s.trim();
}

// A DC like "AMOXICILLINE BIOGARAN" is just the DCI + lab name — pedagogically useless
// for a brand-name quiz. We filter these out.
function looksLikeGeneric(dc, dcis) {
  const dcKey = stripAccents(dc).toUpperCase();
  const dcComparable = dcKey.replace(/[^A-Z0-9]+/g, ' ').trim();
  for (const dci of dcis) {
    const dciKey = stripAccents(dci).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    if (dcKey === dciKey) return true;
    if (dcKey.startsWith(dciKey + ' ')) return true;
    if (dcKey.startsWith(dciKey + '/')) return true;
    if (dcComparable.includes(dciKey) && /\b(ARROW|BGR|BIOGARAN|CRISTERS|EG|EVOLUGEN|MYLAN|SANDOZ|TEVA|VIATRIS|ZENTIVA|ZYDUS)\b/.test(dcComparable)) return true;
  }
  return false;
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function comparable(s) {
  return stripAccents(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// "AMOXICILLINE TRIHYDRATÉE" -> "AMOXICILLINE"
// "SULFATE DE SALBUTAMOL"    -> "SALBUTAMOL"
// "LÉVOTHYROXINE SODIQUE"    -> "LÉVOTHYROXINE"
// "PIVALATE DE TIXOCORTOL"   -> "TIXOCORTOL"
// "TIXOCORTOL (PIVALATE DE)" -> "TIXOCORTOL"
// "CLAVULANATE DE POTASSIUM" -> "ACIDE CLAVULANIQUE" (special-case)
const SALT_ADJ = /\s+(TRIHYDRAT[ÉE]ES?|TRIHYDRAT[ÉE]S?|DIHYDRAT[ÉE]ES?|DIHYDRAT[ÉE]S?|MONOHYDRAT[ÉE]ES?|MONOHYDRAT[ÉE]S?|HEMIHYDRAT[ÉE]ES?|HEMIHYDRAT[ÉE]S?|H[ÉE]MIHYDRAT[ÉE]ES?|H[ÉE]MIHYDRAT[ÉE]S?|ANHYDRES?|SODIQUES?|CALCIQUES?|POTASSIQUES?|MAGN[ÉE]SIQUES?|FUMARIQUES?|MAL[ÉE]IQUES?|TARTRIQUES?|CITRIQUES?|CHLORHYDRIQUES?|CILEX[ÉE]TILS?)$/i;
const SALT_PREFIX = /^(CHLORHYDRATES?|AC[ÉE]TATES?|FUMARATES?|SULFATES?|HYDROG[ÉE]NOSULFATES?|MAL[ÉE]ATES?|TARTRATES?|PHOSPHATES?|GLUCONATES?|B[ÉE]SILATES?|HYDROBROMURES?|M[ÉE]SILATES?|BROMURES?|IODURES?|CITRATES?|NITRATES?|OXALATES?|LACTATES?|BENZOATES?|SUCCINATES?|ST[ÉE]ARATES?|D[ÉE]CANOATES?|PALMITATES?|PIVALATES?|VAL[ÉE]RATES?|XINAFOATES?|CIPIONATES?|DIPROPIONATES?|PROPIONATES?|FUROATES?|HEMIFUMARATES?|H[ÉE]MIFUMARATES?|HEMITARTRATES?|TERT-BUTYLAMINES?)\s+(DE|D')\s*/i;
const SPECIAL_DCI = new Map([
  ['CLAVULANATE DE POTASSIUM', 'ACIDE CLAVULANIQUE'],
  ['CLAVULANATE POTASSIQUE', 'ACIDE CLAVULANIQUE'],
]);
function cleanDci(dci) {
  if (!dci) return dci;
  const upper = dci.trim().toUpperCase();
  if (SPECIAL_DCI.has(upper)) return SPECIAL_DCI.get(upper);
  let s = dci.trim();
  let previous = '';
  while (previous !== s) {
    previous = s;
    s = s.replace(/\s*\((CHLORHYDRATE|AC[ÉE]TATE|FUMARATE|SULFATE|HYDROG[ÉE]NOSULFATE|MAL[ÉE]ATE|TARTRATE|PHOSPHATE|GLUCONATE|B[ÉE]SILATE|HYDROBROMURE|M[ÉE]SILATE|BROMURE|IODURE|CITRATE|NITRATE|OXALATE|LACTATE|BENZOATE|SUCCINATE|ST[ÉE]ARATE|D[ÉE]CANOATE|PALMITATE|PIVALATE|VAL[ÉE]RATE|XINAFOATE|CIPIONATE|DIPROPIONATE|PROPIONATE|FUROATE)\s+DE\)\s*$/i, '');
    s = s.replace(SALT_ADJ, '');
    s = s.replace(SALT_PREFIX, '');
  }
  return s.trim();
}

function pedagogicClasse(dc, dcis, atc) {
  const code = atc || '';
  const name = comparable(dc);
  const joinedDcis = comparable([...dcis].join(' '));

  if (/^N02BE/.test(code) || /PARACETAMOL/.test(joinedDcis)) return 'Antalgiques non opioïdes';
  if (/^N02A/.test(code) || /MORPHINE|OXYCODONE|CODEINE|TRAMADOL|BUPRENORPHINE|METHADONE/.test(joinedDcis)) return 'Antalgiques opioïdes';
  if (/^M01A/.test(code) || /IBUPROFENE|KETOPROFENE|NAPROXENE|DICLOFENAC|FLURBIPROFENE/.test(joinedDcis)) return 'AINS';
  if (/^B01AF/.test(code)) return 'Anticoagulants oraux directs (AOD)';
  if (/^B01AB/.test(code)) return 'Héparines';
  if (/^B01AA/.test(code)) return 'Antivitamines K (AVK)';
  if (/^B01AC/.test(code) || /ACETYLSALICYLIQUE|ACETYLSALICYLATE|CLOPIDOGREL/.test(joinedDcis)) return 'Antiagrégants plaquettaires';
  if (/^A10AB/.test(code)) return 'Insulines rapides';
  if (/^A10AE/.test(code)) return 'Insulines lentes';
  if (/^A10BA/.test(code) || /METFORMINE/.test(joinedDcis)) return 'Antidiabétiques oraux';
  if (/^A10BK/.test(code)) return 'Antidiabétiques inhibiteurs SGLT2';
  if (/^A10BJ/.test(code)) return 'Antidiabétiques analogues GLP-1';
  if (/^J01CR/.test(code)) return 'Antibiotiques pénicillines + inhibiteur';
  if (/^J01CA/.test(code)) return 'Antibiotiques pénicillines';
  if (/^J01D/.test(code)) return 'Antibiotiques céphalosporines';
  if (/^J01FA/.test(code)) return 'Antibiotiques macrolides';
  if (/^J01/.test(code)) return 'Antibiotiques';
  if (/^R03AC/.test(code)) return 'Bronchodilatateurs bêta-2 mimétiques';
  if (/^R03BB/.test(code)) return 'Bronchodilatateurs anticholinergiques';
  if (/^R03A|^R03B|^R03D/.test(code)) return 'Traitements inhalés respiratoires';
  if (/^R06/.test(code)) return 'Antihistaminiques';
  if (/^A02BC/.test(code)) return 'Inhibiteurs de la pompe à protons (IPP)';
  if (/^A02B|^A02A/.test(code)) return 'Antiulcéreux / antiacides';
  if (/^A03AX12/.test(code) || /PHLOROGLUCINOL|TRIMETHYLPHLOROGLUCINOL/.test(joinedDcis)) {
    return 'Antispasmodiques';
  }
  if (/^A06/.test(code)) return 'Laxatifs';
  if (/^A04/.test(code)) return 'Antiémétiques';
  if (/^A07/.test(code)) return 'Antidiarrhéiques';
  if (/^C03CA/.test(code) || /FUROSEMIDE/.test(joinedDcis)) return 'Diurétiques de l’anse';
  if (/^C03A/.test(code)) return 'Diurétiques thiazidiques';
  if (/^C09/.test(code)) return 'Antihypertenseurs IEC/ARA2';
  if (/^C08CA/.test(code)) return 'Inhibiteurs calciques';
  if (/^C07/.test(code)) return 'Bêtabloquants';
  if (/^C10/.test(code)) return 'Hypolipémiants';
  if (/^C01/.test(code)) return 'Médicaments cardiovasculaires';
  if (/^N05BA/.test(code)) return 'Benzodiazépines anxiolytiques';
  if (/^N05CD|^N05CF/.test(code)) return 'Hypnotiques';
  if (/^N05A/.test(code)) return 'Antipsychotiques';
  if (/^N06A/.test(code)) return 'Antidépresseurs';
  if (/^N03A/.test(code)) return 'Antiépileptiques';
  if (/^N04B/.test(code)) return 'Antiparkinsoniens';
  if (/^H03AA/.test(code) || /LEVOTHYROXINE/.test(joinedDcis)) return 'Hormones thyroïdiennes';
  if (/^H02/.test(code)) return 'Corticoïdes systémiques';
  if (/^D07|^R01AD|^R03BA|^S01BA|^S01CA|^S02CA|^S03CA/.test(code)) return 'Corticoïdes';
  if (/^B03A/.test(code)) return 'Supplémentation en fer';
  if (/^A11CC/.test(code)) return 'Vitamine D';
  if (/^A12AA|^A12AX/.test(code)) return 'Supplémentation en calcium';
  if (/^A12BA/.test(code) || /POTASSIUM|CHLORURE DE POTASSIUM/.test(joinedDcis)) return 'Supplémentation en potassium';
  if (/^D08/.test(code)) return 'Antiseptiques';
  if (/^D01A|^G01A|^J02A/.test(code)) return 'Antifongiques';
  if (/^M04/.test(code)) return 'Antigoutteux';
  if (/^S01G/.test(code)) return 'Antiallergiques ophtalmiques';
  if (/^S01A|^S02A|^S03A/.test(code)) return 'Antiinfectieux ophtalmiques/ORL';
  if (/^S01B/.test(code)) return 'Anti-inflammatoires ophtalmiques';
  if (/^V03A/.test(code)) return 'Médicaments de correction métabolique';
  if (/^A11/.test(code)) return 'Vitamines';
  if (/^A12/.test(code)) return 'Supplémentation minérale';
  if (/^J07/.test(code)) return 'Vaccins';
  return null;
}

const LAB_NAME_RE = /\b(ARROW|BGR|BIOGARAN|CRISTERS|EG|EVOLUGEN|MYLAN|SANDOZ|TEVA|VIATRIS|ZENTIVA|ZYDUS)\b/i;
const QUIZ_KEEP_DC_RE = /^(DOLIPRANE|DAFALGAN|EFFERALGAN|KARDEGIC|ELIQUIS|XARELTO|LOVENOX|INNOHEP|COUMADINE|PREVISCAN|VENTOLINE|LASILIX|LOXEN|LEVOTHYROX|SPASFON|FORXIGA|JARDIANCE|OZEMPIC|TRULICITY|SKENAN|ACTISKENAN|OXYNORMORO|SUBUTEX|METHADONE|TEMESTA|LEXOMIL|SERESTA|HALDOL|LOXAPAC|DEPAKINE|KEPPRA|LAMICTAL|NOVORAPID|LANTUS|TOUJEO|TRESIBA|HUMALOG|INEXIUM|GAVISCON|VOGALENE|TIORFAN|TARDYFERON|DIFFU-K|KALEORID|AUGMENTIN|PYOSTACINE|ZITHROMAX|FOSFOMYCINE|BACTRIM|BETADINE|BISEPTINE)\b/i;
const QUIZ_RELEVANT_RE = /parac|anilides|opium|opio|morphine|analges|anti.?inflamm|ains|salicylique|anticoagul|antiagr|hepar|vitamines? k|avk|insuline|diabet|hypogly|biguanide|glucose|glp|sodium-glucose|antib|penicill|cephalospor|macrolide|quinolone|tetracycline|lincosamide|sulfamide|imidazole|triazole|antiviral|antifong|benzodiaz|anxiol|antidep|antipsy|neurolep|antiepilep|dopa|parkinson|hypnot|diuret|angiotensine|enzyme de conversion|iec|beta.?blo|betablo|dihydropyridine|calcique|statine|hmg|thiazid|alpha.?blo|asthme|obstructifs|bêta-2|beta-2|adrenerg|anticholinergiques inhal|corticoides|glucocorticoides|pompe à protons|ipp|antiemet|antidiarr|laxatif|troubles fonctionnels intestinaux|reflux|ulc|potass|sodium|calcium|fer |vitamine|thyroid|antisept|desinfect|vaccin/i;
const QUIZ_EXCLUDE_DC_RE = /^(BEXSERO|BOOSTRIXTETRA|ENGERIX B|GARDASIL|HAVRIX|HEXYON|INFANRIX HEXA|NIMENRIX|PNEUMOVAX|PREVENAR|PRIORIX|REPEVAX|ROTARIX|TETRAVAC|VAXELIS|VAXNEUVANCE|ACULAR|ALONEST|ALLERGODIL|ANTIBIO SYNALAR|AURICULARUM|CROMABAK|CROMADOSES|CROMOPTIC|DULCILARMES|INDOCOLLYRE|MULTICROM|NAABAK|OCUFEN|OPTICRON|AMYCOR|AMYCOR ONYCHOSET|CANDAZOL|FAZOL|FONX|GYNO-PEVARYL|LOMEXIN|MONAZOL|MYCOSTER|ONYTEC|OROFLUCO|POLYGYNAX|BETADINE SCRUB|DIASEPTYL|SEPTIVON|SEPTEAL|CYTEAL|DAKIN|OTIPAX|ATROVENT NASAL|NIFLUGEL|VOLTARENE EMULGEL|IBUFETUM|DICLOFENAC REF|FLECTOR|FLAMMAZINE|DULCILARMES|ARTISIAL|PHOSPHONEUROS|BIONOLYTE|SMOFKABIVEN|CARBOSYMAG|MOXYDAR|XOLAAM|ZYMADUO|OROCAL|CACIT|CALCIDOSE|CALTRATE|FIXICAL|IDEOS|CALCIPRAT|MOVIPREP|XIMEPEG|IZINOVA|COLOPEG|PICOPREP|NORMACOL|EDUCTYL|PSYLIA|SPAGULAX|ANTARENE|ADVILMED|PROFEMIGR|NIFLURIL|SURGAM|NABUCOX|PONSTYL|BREXIN|ACUPAN|TUSSIDANE|POLERY|TUSSIPAX|PADERYL|KIPOS|LUZADEL|BICAFRES|GELOX|RESIKALI|LEDERFOLINE)\b/i;

function isPoorQuizCandidate(med) {
  const code = med.atc || '';
  const name = med.dc || '';
  const classe = med.classe || '';
  if (QUIZ_KEEP_DC_RE.test(name)) return false;
  if (QUIZ_EXCLUDE_DC_RE.test(name)) return true;
  if (/^J07/.test(code)) return true; // Vaccine DCI labels are long and poor quiz material here.
  if (/^S01|^S02|^S03/.test(code)) return true; // Mostly local ophthalmology/ORL, less useful for this general IDE quiz.
  if (/^D01|^D06|^D07|^M02/.test(code)) return true; // Topical dermatology/rheumatology noise.
  if (/^G01/.test(code)) return true; // Local gynecology, low yield for the current quiz.
  if (/ophtalm|topique|dermat|nasales/i.test(classe)) return true;
  return false;
}

function isQuizRelevant(med) {
  const searchable = `${med.dc} ${med.dcis.join(' ')} ${med.classe || ''}`;
  return !LAB_NAME_RE.test(med.dc) && !isPoorQuizCandidate(med) && (QUIZ_KEEP_DC_RE.test(med.dc) || QUIZ_RELEVANT_RE.test(searchable));
}

function isTrivialDcDciMatch(med) {
  const dc = comparable(med.dc);
  if (!dc || !med.dcis.length) return false;
  return med.dcis.some((dci) => {
    const dciKey = comparable(dci);
    return dciKey && (dc === dciKey || dc.includes(dciKey) || dciKey.includes(dc));
  });
}

function quizScore(med) {
  let score = med.boites;
  if (QUIZ_KEEP_DC_RE.test(med.dc)) score += 10_000_000_000;
  if (isTrivialDcDciMatch(med)) score -= 5_000_000_000;
  return score;
}

// Title-case a French uppercase label (for ATC labels):
// "INHIBITEURS DE LA POMPE A PROTONS" -> "Inhibiteurs de la pompe à protons" (best-effort: only first letter)
function softCase(label) {
  if (!label) return label;
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0) + trimmed.slice(1).toLowerCase();
}

// ---------- 6. main ----------

async function main() {
  await fetchBdpm();
  const csvPath = await fetchOpenMedic(OPENMEDIC_YEAR);

  log('# Parsing BDPM');
  const cisMap = parseCis(join(CACHE, BDPM_FILES.cis));
  log(`  CIS commercialised: ${cisMap.size}`);
  const compoMap = parseCompo(join(CACHE, BDPM_FILES.compo));
  log(`  CIS with composition: ${compoMap.size}`);
  const cipToCis = parseCip(join(CACHE, BDPM_FILES.cip));
  log(`  CIP13 entries: ${cipToCis.size}`);

  log('# Aggregating Open Medic');
  const perCip = await aggregateOpenMedic(csvPath);
  log(`  CIP13 with sales: ${perCip.size}`);

  log('# Joining & aggregating per DC');
  const fallback = JSON.parse(readFileSync(join(DATA, 'atc-fallback.json'), 'utf8'));

  // Aggregate every CIP13 with sales -> resolve CIS -> resolve normalized DC.
  // Group all presentations of the same DC together.
  const byDC = new Map(); // normalizedDC -> { dcis:Set, atc4Counts:Map, atc5Counts:Map, libelles, totalBoites, presentations }
  let droppedNoCis = 0, droppedNoCisInfo = 0, droppedNoCompo = 0, droppedEmptyDC = 0;
  for (const [cip13, entry] of perCip) {
    const cis = cipToCis.get(cip13);
    if (!cis) { droppedNoCis++; continue; }
    const cisInfo = cisMap.get(cis);
    if (!cisInfo) { droppedNoCisInfo++; continue; }
    const dcis = compoMap.get(cis);
    if (!dcis || dcis.size === 0) { droppedNoCompo++; continue; }
    const dcNorm = normalizeDC(cisInfo.dc_complet).toUpperCase();
    if (!dcNorm) { droppedEmptyDC++; continue; }
    let agg = byDC.get(dcNorm);
    if (!agg) {
      agg = {
        dcis: new Set(),
        atc4Counts: new Map(),
        atc5Counts: new Map(),
        l_atc4_by_code: new Map(),
        l_atc3_by_code: new Map(),
        totalBoites: 0,
        presentations: 0,
      };
      byDC.set(dcNorm, agg);
    }
    for (const d of dcis) agg.dcis.add(d);
    agg.atc4Counts.set(entry.atc4, (agg.atc4Counts.get(entry.atc4) ?? 0) + entry.boites);
    agg.atc5Counts.set(entry.atc5, (agg.atc5Counts.get(entry.atc5) ?? 0) + entry.boites);
    agg.l_atc4_by_code.set(entry.atc4, entry.l_atc4);
    agg.l_atc3_by_code.set(entry.atc4?.slice(0, 4), entry.l_atc3);
    agg.totalBoites += entry.boites;
    agg.presentations++;
  }
  log(`  CIP13 dropped (no CIS link in BDPM): ${droppedNoCis}`);
  log(`  CIP13 dropped (CIS not commercialised): ${droppedNoCisInfo}`);
  log(`  CIP13 dropped (no SA composition): ${droppedNoCompo}`);
  log(`  CIP13 dropped (empty normalized DC): ${droppedEmptyDC}`);
  log(`  unique DC after join: ${byDC.size}`);

  // Apply DC-level threshold.
  for (const [dc, agg] of byDC) {
    if (agg.totalBoites < MIN_BOITES_DC) byDC.delete(dc);
  }
  log(`  DC kept (>= ${MIN_BOITES_DC.toLocaleString('fr-FR')} boîtes): ${byDC.size}`);

  // Build final dataset
  const out = [];
  let withoutClasse = 0;
  let droppedGeneric = 0;
  for (const [dc, agg] of byDC) {
    // Clean salt forms in DCIs.
    const cleanedDcis = new Set();
    for (const d of agg.dcis) cleanedDcis.add(cleanDci(d));
    agg.dcis = cleanedDcis;
    if (looksLikeGeneric(dc, agg.dcis)) { droppedGeneric++; continue; }
    // Pick most-frequent ATC4 (by boites)
    const atc4 = topKey(agg.atc4Counts);
    const atc5 = topKey(agg.atc5Counts);
    // Prefer the curated fallback (proper accents) over Open Medic's accent-stripped label.
    let classe = null;
    if (atc4) {
      classe = fallback[atc4] ?? null;
      if (!classe) {
        const lib = agg.l_atc4_by_code.get(atc4);
        if (lib) classe = softCase(lib);
      }
    }
    if (!classe && atc4) {
      const atc3 = atc4.slice(0, 4);
      classe = fallback[atc3] ?? null;
      if (!classe) {
        const lib3 = agg.l_atc3_by_code.get(atc3);
        if (lib3) classe = softCase(lib3);
      }
    }
    classe = pedagogicClasse(dc, agg.dcis, atc5 || atc4) ?? classe;
    if (!classe) withoutClasse++;
    out.push({
      dc,
      dcis: [...agg.dcis].sort(),
      atc: atc5 || atc4 || null,
      classe,
      boites: agg.totalBoites,
    });
  }
  out.sort((a, b) => b.boites - a.boites);
  const relevant = out
    .filter((m) => m.dcis.length > 0 && isQuizRelevant(m))
    .sort((a, b) => quizScore(b) - quizScore(a))
    .slice(0, QUIZ_TOP_N)
    .sort((a, b) => b.boites - a.boites);

  // Strip the boites field from the final JSON (kept above only for sorting); also drop any DC with no DCI.
  const final = relevant
    .map(({ boites: _b, ...rest }) => rest);

  writeFileSync(join(DATA, 'medicaments.json'), JSON.stringify(final, null, 2) + '\n');
  log(`# Wrote data/medicaments.json: ${final.length} medicaments`);
  log(`  generics dropped: ${droppedGeneric}`);
  log(`  quiz relevance kept: ${relevant.length}/${out.length} (QUIZ_TOP_N=${QUIZ_TOP_N})`);
  log(`  without classe: ${withoutClasse} (${((withoutClasse / final.length) * 100).toFixed(1)}%)`);
  log(`  top 5: ${final.slice(0, 5).map((m) => m.dc).join(', ')}`);

  const sentinels = ['DOLIPRANE', 'AUGMENTIN', 'KARDEGIC', 'LEVOTHYROX', 'DAFALGAN', 'SPASFON', 'EFFERALGAN'];
  const found = sentinels.filter((s) => final.some((m) => m.dc === s));
  log(`  sentinels found (${found.length}/${sentinels.length}): ${found.join(', ')}`);
  const missing = sentinels.filter((s) => !found.includes(s));
  if (missing.length) log(`  sentinels missing: ${missing.join(', ')}`);
}

function topKey(counts) {
  let bestK = null, bestV = -1;
  for (const [k, v] of counts) {
    if (v > bestV) { bestK = k; bestV = v; }
  }
  return bestK;
}

main().catch((e) => { console.error(e); process.exit(1); });
