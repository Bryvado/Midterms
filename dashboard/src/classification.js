export const classificationMethods = { equal:'Equal intervals', quantile:'Quantiles', natural:'Natural breaks (1D k-means)', std:'Standard-deviation bands' };
// Unweighted geographic units; duplicate values stay together. Raw-value classification.
export function classify(values, method, k = 6) {
  const a = values.filter(Number.isFinite).sort((x,y)=>x-y);
  if (a.length < 2 || a[0] === a.at(-1)) return [];
  const lo = a[0], hi = a.at(-1);
  const q = p => { const t=(a.length-1)*p, i=Math.floor(t); return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*(t-i); };
  let edges;
  if (method === 'equal') edges=Array.from({length:k-1},(_,i)=>lo+(hi-lo)*(i+1)/k);
  else if (method === 'quantile') edges=Array.from({length:k-1},(_,i)=>q((i+1)/k));
  else if (method === 'std') {
    const mean=a.reduce((s,x)=>s+x,0)/a.length;
    const sd=Math.sqrt(a.reduce((s,x)=>s+(x-mean)**2,0)/a.length);
    edges=Array.from({length:k-1},(_,i)=>mean+(i-(k-2)/2)*sd);
  } else if (method === 'natural') {
    // Deterministic Lloyd iterations, weighted by every observation (including ties).
    const count=Math.min(k,new Set(a).size);
    let centers=Array.from({length:count},(_,i)=>lo+(hi-lo)*(i+.5)/count);
    for (let iteration=0;iteration<100;iteration++) {
      const sums=centers.map(()=>0), counts=centers.map(()=>0);
      for (const x of a) { let j=0; for(let i=1;i<centers.length;i++) if(Math.abs(x-centers[i])<Math.abs(x-centers[j])) j=i; sums[j]+=x; counts[j]++; }
      const next=centers.map((c,i)=>counts[i]?sums[i]/counts[i]:c).sort((x,y)=>x-y);
      const done=next.every((c,i)=>Math.abs(c-centers[i])<1e-10); centers=next; if(done) break;
    }
    edges=centers.slice(1).map((c,i)=>(c+centers[i])/2);
  } else throw new Error('Unknown classification method');
  return [...new Set(edges)].filter(x=>Number.isFinite(x)&&x>lo&&x<hi).sort((x,y)=>x-y);
}
