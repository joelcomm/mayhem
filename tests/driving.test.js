import test from 'node:test';
import assert from 'node:assert/strict';
import {traction,boostStep,routeThrough} from '../src/upgrade/driving.js';
test('traction is stable across frame rates and preserves momentum during a slide',()=>{
 const simulate=(hz,hand)=>{let v={x:0,z:30};for(let i=0;i<hz;i++)v=traction(v.x,v.z,Math.PI/2,30,hand,7,1/hz);return v;};
 const a=simulate(30,false), b=simulate(120,false), drift=simulate(60,true);
 assert.ok(Math.abs(a.x-b.x)<1e-9);assert.ok(drift.z>a.z);assert.ok(drift.x<a.x);
});
test('boost fuel never underflows or exceeds capacity',()=>{assert.equal(boostStep(1,true,1),0);assert.equal(boostStep(99,false,1),100);assert.equal(boostStep(100,true,1),70);});
test('navigation uses connected roads and handles unreachable goals',()=>{
 const nodes=[{e:[0,2]},{e:[0,1]},{e:[1,2]},{e:[]}],edges=[{a:0,b:1,len:4},{a:1,b:2,len:4},{a:0,b:2,len:20}];
 assert.deepEqual(routeThrough(nodes,edges,0,2),[0,1,2]);assert.deepEqual(routeThrough(nodes,edges,0,3),[]);assert.deepEqual(routeThrough(nodes,edges,2,2),[2]);
});
