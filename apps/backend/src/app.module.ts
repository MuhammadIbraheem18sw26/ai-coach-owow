import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoachController } from './coach/coach.controller';
import { CoachService } from './coach/coach.service';
import { CommitmentEntity } from './entities/commitment.entity';
import { ExerciseEntity } from './entities/exercise.entity';
import { PrivateChatEntity } from './entities/private-chat.entity';
import { ScenarioEntity } from './entities/scenario.entity';
import { TrustedSessionEntity } from './entities/trusted-session.entity';
import { UserEntity } from './entities/user.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        url:
          process.env.DATABASE_URL ||
          'postgresql://coach:coach@localhost:5432/coach_db',
        entities: [
          UserEntity,
          TrustedSessionEntity,
          ExerciseEntity,
          CommitmentEntity,
          PrivateChatEntity,
          ScenarioEntity,
        ],
        synchronize: true,
      }),
    }),
    TypeOrmModule.forFeature([
      UserEntity,
      TrustedSessionEntity,
      ExerciseEntity,
      CommitmentEntity,
      PrivateChatEntity,
      ScenarioEntity,
    ]),
  ],
  controllers: [CoachController],
  providers: [CoachService],
})
export class AppModule {}
