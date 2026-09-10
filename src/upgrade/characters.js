import * as T from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
const merge=a=>mergeGeometries(a.map(g=>g.index?g.toNonIndexed():g));
const ball=(x,y,z,a,b,c)=>new T.SphereGeometry(1,16,12).scale(a,b,c).translate(x,y,z);
const box=(w,h,d,x,y,z)=>new RoundedBoxGeometry(w,h,d,1,Math.min(w,h,d)*.22).translate(x,y,z);
const pair=f=>merge([-1,1].map(f));
const line=(p,r=.015)=>new T.TubeGeometry(new T.CatmullRomCurve3(p.map(v=>new T.Vector3(...v))),10,r,6,false);
export const skins=[0xf4cba9,0xe5ae86,0xcc906a,0xb77854,0x945c40,0x694331];
const mats=new Map();
export function material(color,kind='cloth'){
 const key=color+kind;if(!mats.has(key))mats.set(key,new T.MeshStandardMaterial({color,roughness:kind==='eye'?.25:kind==='hair'?.7:.9,envMapIntensity:.4}));return mats.get(key);
}
export function kit(){
 const cap=()=>{const g=new T.SphereGeometry(.298,18,12,0,Math.PI*2,0,Math.PI*.53),p=g.attributes.position;
 for(let i=0;i<p.count;i++)p.setY(i,p.getY(i)+Math.max(0,p.getZ(i)/.298)*.2*(1-Math.max(0,p.getY(i)/.298)));
 g.computeVertexNormals();return g.translate(0,1.79,-.035);};
 const head=merge([ball(0,1.735,-.005,.285,.337,.253),...[-1,1].map(s=>ball(s*.282,1.73,-.015,.061,.087,.059)),new T.CylinderGeometry(.105,.125,.2,12).translate(0,1.44,0)]);
 const eyes=pair(s=>ball(s*.109,1.802,.227,.09,.10,.063));
 const iris=pair(s=>ball(s*.109,1.8,.285,.043,.054,.012));
 const pupils=pair(s=>ball(s*.109,1.8,.296,.023,.033,.008));
 const glints=pair(s=>ball(s*.109-.012,1.82,.304,.012,.015,.004));
 const nose=ball(0,1.703,.264,.056,.068,.063);
 const mouth=line([[-.076,1.611,.221],[0,1.591,.243],[.078,1.614,.22]],.012);
 const brows=pair(s=>line([[s*.045,1.923,.205],[s*.106,1.937,.205],[s*.174,1.919,.179]],.022));
 const torso=merge([box(1,.64,.35,0,1.16,0),box(.94,.08,.36,0,.865,0)]);
 const trim=merge([box(.35,.065,.365,0,1.465,0),box(.96,.045,.365,0,.89,0)]);
 const detail=merge([box(.025,.49,.025,0,1.16,.187),box(.21,.14,.028,-.26,1.2,.186),box(.21,.14,.028,.26,1.2,.186)]);
 const leg=merge([new T.CapsuleGeometry(.107,.25,4,10).translate(0,-.21,0),new T.CapsuleGeometry(.092,.25,4,10).translate(0,-.59,0)]);
 const arm=merge([new T.CapsuleGeometry(.097,.2,4,10).translate(0,-.16,0),new T.CapsuleGeometry(.078,.15,4,10).translate(0,-.39,.018)]);
 const hand=merge([ball(0,-.592,.022,.09,.11,.075),ball(.069,-.555,.055,.038,.06,.035)]);
 const shoe=merge([box(.26,.15,.39,0,-.79,.1),ball(0,-.8,.26,.125,.075,.1)]);
 const sole=box(.28,.045,.46,0,-.867,.1);
 const hairs={short:merge([cap(),ball(-.10,2.01,.04,.2,.085,.17),ball(.11,2.025,0,.14,.075,.18)]),bun:merge([cap(),ball(0,2.11,-.13,.15,.13,.14)]),cap:merge([cap(),box(.43,.035,.28,0,1.89,.29)]),long:merge([cap(),...[-2,-1,0,1,2].map(i=>ball(i*.101,1.64,-.222,.085,.31,.1))]),afro:merge(Array.from({length:16},(_,i)=>{const a=i*2.4;return ball(Math.cos(a)*.22,1.99+(i%3)*.04,-.05+Math.sin(a)*.22,.14,.14,.14);})),bald:merge([-1,1].map(s=>ball(s*.25,1.8,-.085,.045,.14,.14)))};
 hairs.spiky=merge([cap(),...[-2,-1,0,1,2].map(i=>ball(i*.088,2.07,.015,.075,.105,.13))]);
 hairs.tall=merge([cap(),ball(0,2.14,-.06,.23,.29,.21)]);
 hairs.mohawk=merge([hairs.bald.clone(),...[-.15,0,.15].map(z=>ball(0,2.08,z,.07,.15,.1))]);
 hairs.beanie=merge([cap(),new T.TorusGeometry(.282,.04,6,18).rotateX(Math.PI/2).translate(0,1.84,-.035),ball(0,2.12,-.035,.06,.06,.06)]);
 hairs.fedora=merge([box(.53,.23,.45,0,2.01,-.04),ball(0,1.88,-.03,.42,.03,.34)]);
 hairs.hardhat=merge([cap(),box(.07,.06,.44,0,2.04,-.035),ball(0,1.87,.02,.32,.025,.31)]);
 return {head,eyes,iris,pupils,glints,nose,mouth,brows,torso,trim,detail,leg,arm,hand,shoe,sole,hairs};
}
export function actor(k,look){
 const g=new T.Group();const add=(geo,col,parent=g,kind='cloth')=>{const m=new T.Mesh(geo,material(col,kind));m.castShadow=m.receiveShadow=true;parent.add(m);return m;};
 const skin=look.skin===0xffd90f?0xe7b18a:look.skin;
 for(const [geo,col] of [[k.torso,look.shirt],[k.trim,0xf2e8d3],[k.detail,0x29444a]])add(geo,col).scale.x=.64;
 const face=new T.Group();g.add(face);add(k.head,skin,face);add(k.nose,skin,face);add(k.mouth,0x773d37,face);add(k.brows,look.hair,face,'hair');add(k.hairs[look.style]||k.hairs.short,look.hair,face,'hair');
 const eyes=new T.Group();face.add(eyes);for(const [geo,col]of[[k.eyes,0xfff9eb],[k.iris,0x55796f],[k.pupils,0x15272b],[k.glints,0xffffff]])add(geo,col,eyes,'eye');
 const limb=(x,y,geo,col)=>{const j=new T.Group();j.position.set(x,y,0);g.add(j);add(geo,col,j);return j;};
 const legL=limb(-.15,.89,k.leg,look.pants),legR=limb(.15,.89,k.leg,look.pants);
 for(const l of[legL,legR]){add(k.shoe,look.shoe||0x284252,l);add(k.sole,0xf3ead6,l);}
 const armL=limb(-.38,1.43,k.arm,look.shirt),armR=limb(.38,1.43,k.arm,look.shirt);for(const a of[armL,armR])add(k.hand,skin,a);
 g.userData={legL,legR,armL,armR,eyes,face,phase:0};return g;
}
export function blink(t){const p=t%4.7;return p<.15?Math.max(.04,Math.abs(p-.075)/.075):1;}
