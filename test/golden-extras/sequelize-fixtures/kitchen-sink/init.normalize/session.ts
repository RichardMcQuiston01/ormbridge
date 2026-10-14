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
  declare deletedAt: CreationOptional<Date | null>;
  declare openedAt: CreationOptional<Date>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare accountId: CreationOptional<string | null>;

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
        deletedAt: DataTypes.DATE,
        openedAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        accountId: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'Session',
        tableName: 'session',
        timestamps: true,
        underscored: true,
        indexes: [
          { unique: true, fields: ['account_id', 'opened_at'] },
        ],
      }
    );
    return Session;
  }
}
