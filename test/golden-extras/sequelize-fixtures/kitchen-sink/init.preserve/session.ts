import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Account } from './account.js';

export class Session extends Model<
  InferAttributes<Session>,
  InferCreationAttributes<Session>
> {
  declare id: CreationOptional<string>;
  declare token: CreationOptional<string | null>;
  declare deleted_at: CreationOptional<Date | null>;
  declare opened_at: CreationOptional<Date>;
  declare account_id: CreationOptional<string | null>;

  declare account?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Session {
    Session.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        token: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4 },
        deleted_at: DataTypes.DATE,
        opened_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        account_id: DataTypes.BIGINT,
      },
      {
        sequelize,
        modelName: 'Session',
        tableName: 'sessions',
        timestamps: false,
        indexes: [
          { unique: true, fields: ['account_id', 'opened_at'] },
        ],
      }
    );
    return Session;
  }
}
