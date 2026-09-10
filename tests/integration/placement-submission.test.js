import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { prisma } from '../../src/lib/prisma.js';
import router from '../../src/routes/onboarding-assessment.js';

// Exercise the real route and middleware with an in-memory database boundary.
test('placement API owns scores, preserves evidence and deduplicates retries per learner', async (t) => {
  const rows = [];
  const originalFind = prisma.user.findUnique;
  prisma.user.findUnique = async ({where}) => ({id:where.id, role:'learner', isDisabled:false});
  t.after(() => { prisma.user.findUnique = originalFind; });
  const tx = {
    $queryRaw: async () => [{locked:1}],
    assessmentSubmission: {
      findFirst: async ({where}) => rows.find(row => row.userId===where.userId && row.reviewMeta.attemptId===where.reviewMeta.equals),
      create: async ({data}) => { const row={id:rows.length+1,...data}; rows.push(row); return row; },
    },
  };
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async callback => callback(tx);
  t.after(() => { prisma.$transaction = originalTransaction; });
  const app=express(); app.use(express.json({limit:'5mb'}));
  app.use((req,_res,next)=>{req.session={user:{id:Number(req.headers['x-test-user'] || 1)}};next();});
  app.use(router);
  const answers={
    coreAnswers:Object.fromEntries(Array.from({length:24},(_,i)=>['c'+(i+1),0])),
    readingAnswers:Object.fromEntries([1,2,3].flatMap(p=>[1,2,3,4].map(q=>[`r${p}q${q}`,0]))),
    listeningAnswers:Object.fromEntries([1,2,3].flatMap(p=>[1,2,3].map(q=>[`l${p}q${q}`,0]))),
  };
  const payload={attemptId:'test-attempt-123456',score:100,cefr:'C2',text:'This is my writing sample.',reviewMeta:{answers,writingTaskId:'workplace',speaking:{mode:'live'},placementResult:{score:100,band:{level:'C2'}}}};
  const first=(await request(app).post('/me/assessment').send(payload).expect(201)).body;
  assert.notEqual(first.submission.score,100);
  assert.equal(first.submission.cefr,null);
  assert.equal(first.submission.status,'awaiting_review');
  assert.equal(first.submission.reviewMeta.placementResult.band,null);
  const retry=(await request(app).post('/me/assessment').send(payload).expect(200)).body;
  assert.equal(retry.submission.id,first.submission.id); assert.equal(retry.idempotent,true);
  const other=(await request(app).post('/me/assessment').set('x-test-user','2').send(payload).expect(201)).body;
  assert.notEqual(other.submission.id,first.submission.id);
  await request(app).post('/me/assessment').send({...payload,reviewMeta:{...payload.reviewMeta,answers:{}}}).expect(400);
  await request(app).post('/me/assessment').send({...payload,reviewMeta:{...payload.reviewMeta,speaking:{}}}).expect(400);
  await request(app).post('/me/assessment').send({...payload,text:Array(601).fill('word').join(' ')}).expect(413);
  assert.equal(rows.length,2);
});
