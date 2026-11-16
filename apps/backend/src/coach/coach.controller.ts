import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CoachService } from './coach.service';

@Controller('api')
export class CoachController {
  constructor(private readonly coachService: CoachService) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      backend: 'nestjs-typeorm',
    };
  }

  @Get('scenarios')
  getScenarios() {
    return this.coachService.getScenarios();
  }

  @Get('member-workspace')
  getMemberWorkspace(@Query('trustedSessionId') trustedSessionId: string) {
    return this.coachService.getMemberWorkspace(trustedSessionId);
  }

  @Post('feedback')
  generateFeedback(
    @Body()
    payload: {
      trustedSessionId: string;
      newExercise: { week: number; question: string; answer: string };
      simulateFailure?: boolean;
    },
  ) {
    return this.coachService.generateFeedback(payload);
  }

  @Post('commitments')
  saveCommitment(
    @Body() payload: { trustedSessionId: string; week: number; text: string },
  ) {
    return this.coachService.saveCommitment(payload);
  }

  @Post('private-chat/search')
  searchPrivateChat(
    @Body()
    payload: {
      trustedSessionId: string;
      query: string;
      scope?: 'private_chat' | 'all';
      topK?: number;
    },
  ) {
    return this.coachService.searchPrivateChatAndHistory(payload);
  }

  @Post('private-chat/messages')
  sendPrivateChat(
    @Body()
    payload: {
      trustedSessionId: string;
      week: number;
      message: string;
    },
  ) {
    return this.coachService.sendPrivateChatMessage(payload);
  }

  @Post('reset')
  reset() {
    return this.coachService.resetDatabase();
  }
}
