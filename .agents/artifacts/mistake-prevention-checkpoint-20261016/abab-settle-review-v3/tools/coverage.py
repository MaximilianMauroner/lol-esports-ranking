import sys,pathlib
N=pathlib.Path(sys.argv[1])
inv=[l.split('  ',1)[1] for l in (N/'inventory-sha256.txt').read_text().splitlines()]
files=sorted(str(p) for p in N.rglob('*') if p.is_file())
inside=[p for p in inv if p.startswith(str(N)+'/')]
outside=[p for p in inv if not p.startswith(str(N)+'/')]
missing=[f for f in files if f not in inv]
print('inventoryEntries',len(inv),'insidePackage',len(inside),'outsidePackage',len(outside))
print('packageFiles',len(files))
print('notCovered',missing)
print('dupes',len(inv)-len(set(inv)))
for p in outside: print('OUTSIDE',p)
