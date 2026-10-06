import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import router from '../../src/routes/sessions/classroom.js';
import { prisma } from '../../src/lib/prisma.js';

test('teacher PDF regions persist for learner late join and invalid coordinates are excluded', async () => {
  const original={user:prisma.user.findUnique,session:prisma.session.findUnique,update:prisma.session.update};
  let state={};
  prisma.user.findUnique=async({where})=>({id:where.id,role:where.id===20?'teacher':'learner',isDisabled:false,passwordChangedAt:null});
  prisma.session.findUnique=async()=>({id:42,teacherId:20,userId:10,status:'completed',participants:[],classroomState:state});
  prisma.session.update=async({data})=>{state=data.classroomState;return {classroomState:state};};
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.session={user:{id:Number(req.headers['x-test-user']||20)}};next();});app.use(router);
  try {
    const view={page:2,manual:true,region:{x:.2,y:.1,width:.5,height:.4}};
    const saved=await request(app).patch('/sessions/42/classroom-state').send({pdfScroll:{resourceId:'pdf',page:2,scrollNorm:0,view}});
    assert.equal(saved.statusCode,200);assert.deepEqual(saved.body.state.pdfScroll.view,view);
    const restored=await request(app).get('/sessions/42/classroom-state').set('x-test-user','10');
    assert.equal(restored.statusCode,200);assert.deepEqual(restored.body.state.pdfScroll.view,view);
    const forbidden=await request(app).patch('/sessions/42/classroom-state').set('x-test-user','10').send({pdfScroll:{resourceId:'pdf',page:2,scrollNorm:0,view}});
    assert.equal(forbidden.statusCode,403);
    const invalid=await request(app).patch('/sessions/42/classroom-state').send({pdfScroll:{resourceId:'pdf',page:2,scrollNorm:0,view:{manual:true,region:{x:0,y:0,width:'bad',height:.4}}}});
    assert.equal(invalid.statusCode,200);assert.equal(invalid.body.state.pdfScroll.view,undefined);
  } finally {prisma.user.findUnique=original.user;prisma.session.findUnique=original.session;prisma.session.update=original.update;}
});
