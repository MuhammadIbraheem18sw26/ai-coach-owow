import * as fs from 'fs';
import * as path from 'path';
import { HttpException, HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { CommitmentEntity } from '../entities/commitment.entity';
import { ExerciseEntity } from '../entities/exercise.entity';
import { PrivateChatEntity } from '../entities/private-chat.entity';
import { ScenarioEntity } from '../entities/scenario.entity';
import { TrustedSessionEntity } from '../entities/trusted-session.entity';
import { UserEntity } from '../entities/user.entity';

const DEFAULT_USERS: Record<string, { id: string; name: string; role: string }> = {
  'member-101': {
    id: 'member-101',
    name: 'Alex Rivera (Member 101)',
    role: 'Engineering Manager — Continuity Scenario',
  },
  'member-202': {
    id: 'member-202',
    name: 'Jordan Lee (Member 202)',
    role: 'Product Lead — Revised Commitment Scenario',
  },
  'member-303': {
    id: 'member-303',
    name: 'Sam Taylor (Member 303)',
    role: 'Tech Lead — No-History Cold Start Scenario',
  },
  'member-404': {
    id: 'member-404',
    name: 'Morgan Chen (Member 404)',
    role: 'Director — Cross-Member Isolation Fixture',
  },
};

@Injectable()
export class CoachService implements OnModuleInit {
  private readonly aiServiceUrl: string;

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(TrustedSessionEntity)
    private readonly sessionRepo: Repository<TrustedSessionEntity>,
    @InjectRepository(ExerciseEntity)
    private readonly exerciseRepo: Repository<ExerciseEntity>,
    @InjectRepository(CommitmentEntity)
    private readonly commitmentRepo: Repository<CommitmentEntity>,
    @InjectRepository(PrivateChatEntity)
    private readonly privateChatRepo: Repository<PrivateChatEntity>,
    @InjectRepository(ScenarioEntity)
    private readonly scenarioRepo: Repository<ScenarioEntity>,
  ) {
    this.aiServiceUrl = (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
  }

  async onModuleInit() {
    await this.seedDatabaseIfEmpty(false);
  }

  private loadFixture() {
    const fixturePath = path.resolve(__dirname, '../../data/fixture.json');
    return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  }

  async seedDatabaseIfEmpty(forceReset = false) {
    if (forceReset) {
      await this.scenarioRepo.clear();
      await this.privateChatRepo.clear();
      await this.commitmentRepo.clear();
      await this.exerciseRepo.clear();
      await this.sessionRepo.clear();
      await this.userRepo.clear();
    }

    const userCount = await this.userRepo.count();
    if (userCount > 0 && !forceReset) {
      return;
    }

    const fixture = this.loadFixture();
    const memberIds = new Set<string>();
    for (const s of fixture.trustedSessions) memberIds.add(s.memberId);
    for (const r of fixture.records) memberIds.add(r.memberId);

    for (const memberId of Array.from(memberIds).sort()) {
      const profile = DEFAULT_USERS[memberId] || {
        id: memberId,
        name: `Member ${memberId}`,
        role: 'Leadership Participant',
      };
      await this.userRepo.save(this.userRepo.create(profile));
    }

    for (const s of fixture.trustedSessions) {
      await this.sessionRepo.save(
        this.sessionRepo.create({ id: s.id, member_id: s.memberId }),
      );
    }

    for (const rec of fixture.records) {
      if (rec.type === 'exercise') {
        await this.exerciseRepo.save(
          this.exerciseRepo.create({
            id: rec.id,
            member_id: rec.memberId,
            visibility: rec.visibility,
            week: rec.week,
            question: rec.question || null,
            text: rec.text,
          }),
        );
      } else if (rec.type === 'commitment') {
        await this.commitmentRepo.save(
          this.commitmentRepo.create({
            id: rec.id,
            member_id: rec.memberId,
            visibility: rec.visibility,
            week: rec.week,
            status: rec.status || 'active',
            replaced_by: rec.replacedBy || null,
            text: rec.text,
          }),
        );
      } else if (rec.type === 'private_chat') {
        await this.privateChatRepo.save(
          this.privateChatRepo.create({
            id: rec.id,
            member_id: rec.memberId,
            visibility: rec.visibility,
            sender_role: rec.senderRole || 'member',
            week: rec.week,
            text: rec.text,
          }),
        );
      }
    }

    for (const sc of fixture.scenarios) {
      await this.scenarioRepo.save(
        this.scenarioRepo.create({
          id: sc.id,
          trusted_session_id: sc.trustedSessionId,
          week: sc.newExercise.week,
          question: sc.newExercise.question,
          answer: sc.newExercise.answer,
        }),
      );
    }
  }

  async resolveMemberId(trustedSessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: trustedSessionId } });
    if (!session) {
      throw new HttpException('Invalid or untrusted session ID.', HttpStatus.FORBIDDEN);
    }
    return session.member_id;
  }

  async getScenarios() {
    const scenarios = await this.scenarioRepo.find();
    const order: Record<string, number> = {
      continuity: 0,
      'revised-commitment': 1,
      'no-history': 2,
    };
    scenarios.sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99));

    const sessions = await this.sessionRepo.find({ order: { id: 'ASC' } });
    let aiHealth = {
      adapter: 'langgraph:ChatOpenAI(gpt-4o-mini)',
      embeddingModel: 'langchain-openai:text-embedding-3-small',
    };
    try {
      const res = await axios.get(`${this.aiServiceUrl}/api/health`, { timeout: 3000 });
      aiHealth = res.data;
    } catch {
      // fallback label if AI container is still warming up
    }

    return {
      scenarios: scenarios.map((s) => ({
        id: s.id,
        trustedSessionId: s.trusted_session_id,
        newExercise: {
          week: s.week,
          question: s.question,
          answer: s.answer,
        },
      })),
      trustedSessions: sessions.map((s) => ({ id: s.id, memberId: s.member_id })),
      adapter: `nestjs-typeorm -> ${aiHealth.adapter}`,
      storageBackend: 'nestjs-typeorm + postgresql(pgvector)',
      embeddingModel: aiHealth.embeddingModel,
    };
  }

  async getMemberWorkspace(trustedSessionId: string) {
    const memberId = await this.resolveMemberId(trustedSessionId);
    const user =
      (await this.userRepo.findOne({ where: { id: memberId } })) ||
      DEFAULT_USERS[memberId] || {
        id: memberId,
        name: `Member ${memberId}`,
        role: 'Leadership Participant',
      };

    const exercises = await this.exerciseRepo.find({
      where: { member_id: memberId },
      order: { week: 'DESC' },
    });
    const commitments = await this.commitmentRepo.find({
      where: { member_id: memberId },
      order: { week: 'DESC' },
    });
    const privateChats = await this.privateChatRepo.find({
      where: { member_id: memberId },
      order: { created_at: 'ASC' },
    });

    return {
      trustedSessionId,
      user: { id: user.id, name: user.name, role: user.role },
      storageBackend: 'nestjs-typeorm + postgresql(pgvector)',
      embeddingModel: 'langchain-openai:text-embedding-3-small',
      exercises: exercises.map((e) => ({
        id: e.id,
        memberId: e.member_id,
        type: 'exercise',
        visibility: e.visibility,
        week: e.week,
        question: e.question,
        text: e.text,
      })),
      commitments: commitments.map((c) => ({
        id: c.id,
        memberId: c.member_id,
        type: 'commitment',
        visibility: c.visibility,
        week: c.week,
        status: c.status,
        replacedBy: c.replaced_by,
        text: c.text,
      })),
      privateChats: privateChats.map((ch) => ({
        id: ch.id,
        memberId: ch.member_id,
        type: 'private_chat',
        visibility: ch.visibility,
        senderRole: ch.sender_role,
        week: ch.week,
        text: ch.text,
      })),
    };
  }

  private async getAllRecordsFromTypeOrm() {
    const exercises = await this.exerciseRepo.find({ order: { created_at: 'ASC' } });
    const commitments = await this.commitmentRepo.find({ order: { created_at: 'ASC' } });
    const privateChats = await this.privateChatRepo.find({ order: { created_at: 'ASC' } });

    return [
      ...exercises.map((e) => ({
        id: e.id,
        memberId: e.member_id,
        type: 'exercise',
        visibility: e.visibility,
        week: e.week,
        question: e.question,
        text: e.text,
      })),
      ...commitments.map((c) => ({
        id: c.id,
        memberId: c.member_id,
        type: 'commitment',
        visibility: c.visibility,
        week: c.week,
        status: c.status,
        replacedBy: c.replaced_by,
        text: c.text,
      })),
      ...privateChats.map((ch) => ({
        id: ch.id,
        memberId: ch.member_id,
        type: 'private_chat',
        visibility: ch.visibility,
        senderRole: ch.sender_role,
        week: ch.week,
        text: ch.text,
      })),
    ];
  }

  async generateFeedback(payload: {
    trustedSessionId: string;
    newExercise: { week: number; question: string; answer: string };
    simulateFailure?: boolean;
  }) {
    if (payload.simulateFailure) {
      throw new HttpException(
        'Coaching model service is temporarily unavailable. Your exercise answer is safe—please retry.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const resolvedMemberId = await this.resolveMemberId(payload.trustedSessionId);
    const records = await this.getAllRecordsFromTypeOrm();
    try {
      const res = await axios.post(`${this.aiServiceUrl}/api/feedback`, {
        ...payload,
        resolvedMemberId,
        records,
      });
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status || HttpStatus.BAD_GATEWAY;
      const detail = err?.response?.data?.detail || err?.message || 'AI service error';
      throw new HttpException(detail, status);
    }
  }

  async saveCommitment(payload: { trustedSessionId: string; week: number; text: string }) {
    const memberId = await this.resolveMemberId(payload.trustedSessionId);
    const cleaned = payload.text.trim();
    const totalCount = await this.commitmentRepo.count();
    const newId = `com-${memberId.split('-').pop()}-w${payload.week}-${totalCount + 1}`;

    await this.commitmentRepo.update(
      { member_id: memberId, visibility: 'exercise', status: 'active' },
      { status: 'superseded', replaced_by: newId },
    );

    const entity = await this.commitmentRepo.save(
      this.commitmentRepo.create({
        id: newId,
        member_id: memberId,
        visibility: 'exercise',
        week: payload.week,
        status: 'active',
        text: cleaned,
      }),
    );

    try {
      await axios.post(`${this.aiServiceUrl}/api/commitments`, {
        ...payload,
        id: newId,
      });
    } catch {
      // PGVector index sync
    }

    return {
      id: entity.id,
      memberId: entity.member_id,
      type: 'commitment',
      visibility: entity.visibility,
      week: entity.week,
      status: entity.status,
      text: entity.text,
    };
  }

  async searchPrivateChatAndHistory(payload: {
    trustedSessionId: string;
    query: string;
    scope?: 'private_chat' | 'all';
    topK?: number;
  }) {
    await this.resolveMemberId(payload.trustedSessionId);
    try {
      const res = await axios.post(`${this.aiServiceUrl}/api/private-chat/search`, payload);
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status || HttpStatus.BAD_GATEWAY;
      const detail = err?.response?.data?.detail || err?.message || 'Vector search failed';
      throw new HttpException(detail, status);
    }
  }

  async sendPrivateChatMessage(payload: {
    trustedSessionId: string;
    week: number;
    message: string;
  }) {
    const memberId = await this.resolveMemberId(payload.trustedSessionId);
    let data: any;
    try {
      const res = await axios.post(`${this.aiServiceUrl}/api/private-chat/messages`, payload);
      data = res.data;
    } catch (err: any) {
      const status = err?.response?.status || HttpStatus.BAD_GATEWAY;
      const detail = err?.response?.data?.detail || err?.message || 'Private chat AI error';
      throw new HttpException(detail, status);
    }

    // Persist both messages into TypeORM private_chats table
    if (data?.memberMessage) {
      await this.privateChatRepo.save(
        this.privateChatRepo.create({
          id: data.memberMessage.id,
          member_id: memberId,
          visibility: 'private_chat',
          sender_role: 'member',
          week: payload.week,
          text: data.memberMessage.text,
        }),
      );
    }
    if (data?.coachMessage) {
      await this.privateChatRepo.save(
        this.privateChatRepo.create({
          id: data.coachMessage.id,
          member_id: memberId,
          visibility: 'private_chat',
          sender_role: 'coach',
          week: payload.week,
          text: data.coachMessage.text,
        }),
      );
    }
    return data;
  }

  async resetDatabase() {
    await this.seedDatabaseIfEmpty(true);
    try {
      await axios.post(`${this.aiServiceUrl}/api/reset`);
    } catch {
      // ignore if AI service resets independently
    }
    return { status: 'reset', storageBackend: 'nestjs-typeorm + postgresql(pgvector)' };
  }
}
