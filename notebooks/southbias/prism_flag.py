"""Does the A2 flag fire differently on PRISM and Daymet? 2015-2025 on Daymet, 2023-2025 also on PRISM, each year
against the envelope of the fold that left it out; also prints the 2026 ranges centred on A1. Run after run.py
(uses its cached fits). Prints share of each strip's weight flagged, south to north."""
import sys, numpy as np, pandas as pd, json
from pathlib import Path
W=str(Path(__file__).resolve().parents[2])
sys.path[:0]=[W+"/notebooks/southbias"]
import run, sb
run._init()
fits=run.all_fits(1)
from fit import south_bias as SB
from live import build_live as L
envs={}
for y in SB.YEARS:
    _,_,train,_=run.fold_data(y); envs[y]=sb.envelope(run.CTX.cum, train.h.to_numpy(), train.y.to_numpy())
out={}
for y in SB.YEARS:
    p3,cut=SB.FOLDS[y]; cutc=np.array([cut[b]-1 for b in SB.CBAND])
    srcs={"daymet":SB.daily_dd(*SB.daymet(y))}
    if y>=2023: srcs["prism"]=SB.daily_dd(*SB.prism(y))
    for src,inc in srcs.items():
        st=np.array(L.band_reach(sb.sighting_share(sb.Cand("p3",p3).flight(inc,SB.clat),cutc,SB.EPROF),SB.BW),float)
        out[f"{y} {src}"]=[round(sb.blend_weight(sb.flagged(inc,envs[y],st[B,1]-1),SB.BW[B])/0.5,3) for B in range(5)]
for k,v in out.items(): print(k,v)
# A1-centred 2026 ranges
d=pd.read_csv(W+"/notebooks/southbias/results/loyo_rows.csv"); r=pd.read_csv(W+"/notebooks/southbias/results/rows_2026.csv")
for q in ("onset","peak"):
    lo,hi=np.percentile(d[q]-d[f"a1_cap_{q}"],[10,90])
    for x in r.itertuples():
        c=getattr(x,f"a1_cap_{q}"); print(x.band,q,"real",getattr(x,q),"A1 range",round(c+lo,1),round(c+hi,1),"cal",round(getattr(x,f"cal_{q}"),1))
