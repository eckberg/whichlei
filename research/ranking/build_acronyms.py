"""
Slice 10: a small set of well-known acronym and short-name queries, kept apart from the
evaluation set built by build_eval.py. Writes eval/acronyms.tsv.

Each target was chosen by hand: the group's main entity, found by its legal name in the
golden copy. This script verifies every one against the golden copy (research/data/
compact.tsv, 2026-09-16) and the level 2 relationships, and records what it found in the
`verified` column: legal name, country, entity and registration status, category, and
whether the entity has an accounting parent in GLEIF (a group's top entity has none).
A target that is missing or not ACTIVE fails the build.

kind:
  name      the query is a word of the legal name ("BP" -> BP P.L.C.)
  initials  the query is the initials of the legal name's words, legal form left out
            ("SEB" -> Skandinaviska Enskilda Banken AB)
  prefix    the query is the start of those initials ("PKO" -> Powszechna Kasa
            Oszczednosci Bank Polski); kept as a hard case

Split: as build_eval.py, exactly 50/50 by entity: targets sorted by sha1("20260927:" +
LEI), the first half is train. Nothing is fitted on test.

  python3 build_acronyms.py      # needs research/data/compact.tsv and signals/has_parent.tsv
"""
import csv
import hashlib
import os

from paths import DATA_DIR, EVAL, SIG

# query, kind, target LEI, alternative LEIs (also correct)
SET = [
    ('SEB', 'initials', 'F3JS33DEI6XQ4ZBPTN86', ''),
    ('IBM', 'initials', 'VGRQXHF3J8VDLUA7XE92', ''),
    ('BMW', 'initials', 'YEH5ZCD6E441RHVHD759', ''),
    ('KLM', 'initials', '724500LQC3HN5O30LK18', ''),
    ('AIG', 'initials', 'ODVCVCQG2BP6VHV36M30', ''),
    ('UPS', 'initials', 'D01LMJZU09ULLNCY6Z23', '1T2XGWDXQ30WC74GIJ96'),
    ('EDF', 'initials', '549300X3UK4GG3FNMO06', ''),
    ('RBC', 'initials', 'ES7IP3U3RHIGC71XBU11', ''),
    ('BBVA', 'initials', 'K8MS7FD7N5Z2WQ51AZ71', ''),
    ('IMF', 'initials', 'E7EXN6FJGRUTJYNZ3Z71', ''),
    ('ECB', 'initials', '549300DTUYXVMJXZNY75', ''),
    ('EIB', 'initials', '5493006YXS1U5GIHE750', ''),
    ('AMD', 'initials', 'R2I72C950HOYXII45366', ''),
    ('HBO', 'initials', '549300TMFIX6P4TRT588', ''),
    ('BBC', 'initials', '5493000IBP32UQZ0KL24', ''),
    ('GE', 'initials', '3C7474T6CDKPR9K6YT90', ''),
    ('GM', 'initials', '54930070NSV60J38I987', ''),
    ('CBA', 'initials', 'MSFSBD3QN1GSN7Q6C537', ''),
    ('NAB', 'initials', 'F8SB4JFBSYQFRQEH3Z21', ''),
    ('ANZ', 'initials', 'JHE42UYNWWTJB8YTTU19', ''),
    ('LBG', 'initials', '549300PPXHEU2JF0AM85', ''),
    ('LSEG', 'initials', '213800QAUUUP6I445N30', ''),
    ('BAT', 'initials', '213800FKA5MF17RJKT63', ''),
    ('IAG', 'initials', '959800TZHQRUSH1ESL13', ''),
    ('SBI', 'initials', '5493001JZ37UBBZF6L49', ''),
    ('TCS', 'initials', '335800ZJKU9GPQRE2U66', ''),
    ('PZU', 'initials', 'QLPCKOOKVX32FUELX240', ''),
    ('DB', 'initials', '7LTWFZYICNSX8D621K86', ''),
    ('SG', 'initials', 'O2RNE8IBXP4R0TD8PU41', ''),
    ('RBI', 'initials', '9ZHRYM6F437SQJ6OUG95', ''),
    ('PKO', 'prefix', 'P4GTT6GF1W40CVIMFR43', ''),
    ('BNY', 'prefix', 'WFLLPEPC7FZXENRZV188', ''),
    ('BP', 'name', '213800LH1BZH3DI6G760', ''),
    ('SAS', 'name', '549300ZJTLE5T4SGP021', ''),
    ('HSBC', 'name', 'MLU0ZO3ML4LN2LL2TL39', ''),
    ('BNP', 'name', 'R0MUWSFPU8MPRO8K5P83', ''),
    ('ABB', 'name', '5493000LKVGOO9PELI61', ''),
    ('UBS', 'name', '549300SZJ9VS8SGXAN81', 'BFM8T61CT2L1QCEMIK50'),
    ('KPN', 'name', '549300YO0JZHAL7FVP81', ''),
    ('ING', 'name', '549300NYKK9MWM7GGW15', ''),
    ('AT&T', 'name', '549300Z40J86GGSTL398', ''),
    ('H&M', 'name', '529900O5RR7R39FRDM42', ''),
    ('3M', 'name', 'LUZQVYP4VS22CLWDAR65', ''),
    ('SAP', 'name', '529900D6BF99LW9R2E68', ''),
    ('AXA', 'name', 'F5WCUMTUM4RKZ1MAIE39', ''),
    ('DNB', 'name', '549300GKFG0RYRRQ1414', ''),
    ('SKF', 'name', '549300B6HWYEE57O8J84', ''),
    ('ENI', 'name', 'BUCRF72VH5RBN7X3VL35', ''),
    ('BHP', 'name', 'WZE1WSENV6JSZFK0JC28', ''),
    ('RWE', 'name', '529900GB7KCA94ACC940', ''),
    ('BAE', 'name', '8SVCSVKSGDWMW2QHOH83', ''),
    ('KBC', 'name', '213800X3Q9LSAKRUWY91', ''),
    ('OMV', 'name', '549300V62YJ9HTLRI486', ''),
    ('TUI', 'name', '529900SL2WSPV293B552', ''),
    ('ICA', 'name', '549300ZEFN8VKPK9I111', ''),
    ('SCA', 'name', '549300FW5JDRV1IJ0M67', ''),
    ('SSAB', 'name', '529900329VS14ZIML164', ''),
    ('NN', 'name', '724500OHYNDT9OY6Q215', ''),
    ('ABN', 'name', 'BFXS5XCH7N0Y05NIXW11', ''),
    ('CVS', 'name', '549300EJG376EN5NQE29', ''),
    ('GSK', 'name', '5493000HZTVUYLO1D793', ''),
    ('TSB', 'name', '549300XP222MV7P3CC54', ''),
    ('NCC', 'name', '213800WRGLW3CY4MHW53', ''),
    ('DSV', 'name', '529900X41C0BSLK67H70', ''),
    ('ISS', 'name', '213800LEZA58SZNCBN19', ''),
    ('NKT', 'name', '529900197LKWCEQ0NL18', ''),
    ('BT', 'name', '213800LRO7NS5CYQMN21', ''),
    ('MSCI', 'name', '549300HTIN2PD78UB763', ''),
    ('CME', 'name', 'LCZ7XYGSLJUHFXXNXD88', ''),
    ('S&P', 'name', 'Y6X4K52KMJMZE7I7MY94', ''),
    ('OTP', 'name', '529900W3MOO00A18X956', ''),
    ('MOL', 'name', '213800R83KX5FQFGXS67', ''),
    ('KGHM', 'name', 'G30CO71KTT9JDYJESN22', ''),
    ('UPM', 'name', '213800EC6PW5VU4J9U64', ''),
    ('HDFC', 'name', '335800ZQ6I4E2JXENC50', ''),
    ('LVMH', 'name', 'IOG4E947OATN0KJYSD45', ''),
    ('MTG', 'name', '549300E8NDODRSX29339', ''),
    ('SBAB', 'name', 'H0YX5LBGKDVOWCXBZ594', ''),
    ('PNC', 'name', 'CFGNEKW0P8842LEUIA51', ''),
]


def assign_split(leis):
    order = sorted(leis, key=lambda lei: hashlib.sha1(f'20260927:{lei}'.encode()).hexdigest())
    half = len(order) // 2
    return {lei: ('train' if i < half else 'test') for i, lei in enumerate(order)}


def main():
    want = {lei for _, _, t, alt in SET for lei in [t, *filter(None, alt.split('|'))]}
    found = {}
    with open(os.path.join(DATA_DIR, 'compact.tsv'), encoding='utf8') as f:
        for line in f:
            x = line.rstrip('\n').split('\t')
            if x[0] in want:
                found[x[0]] = x
    parent = {}
    with open(os.path.join(SIG, 'has_parent.tsv'), encoding='utf8') as f:
        next(f)
        for line in f:
            lei, direct, _ = line.rstrip('\n').split('\t')
            if lei in want:
                parent[lei] = direct == '1'
    missing = sorted(want - found.keys())
    if missing:
        raise SystemExit(f'not in the golden copy: {missing}')
    out = os.path.join(EVAL, 'acronyms.tsv')
    split = assign_split([lei for _, _, lei, _ in SET])
    with open(out, 'w', encoding='utf8', newline='') as f:
        w = csv.writer(f, delimiter='\t', lineterminator='\n')
        w.writerow(['query', 'target_lei', 'stratum', 'split', 'qtype', 'alt_leis', 'entity_name', 'verified'])
        for query, kind, lei, alt in SET:
            x = found[lei]
            if x[4] != 'ACTIVE':
                raise SystemExit(f'{query}: {lei} is {x[4]}')
            top = 'has a parent' if parent.get(lei) else 'no parent'
            verified = f'golden copy 2026-09-16: {x[2]}, {x[4]}/{x[5]}, {x[6]}, {top}'
            w.writerow([query, lei, 'acronym', split[lei], kind, alt, x[1], verified])
    print(f'wrote {out}: {len(SET)} queries')


if __name__ == '__main__':
    main()
