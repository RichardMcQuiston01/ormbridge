import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Profile } from './profile.js';
import type { Session } from './session.js';

export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  declare id: CreationOptional<number>;
  declare readonly created_at: CreationOptional<Date>;
  declare readonly updated_at: CreationOptional<Date>;
  declare deleted_at: CreationOptional<Date | null>;
  declare email: string;
  declare balance: string;
  declare score: CreationOptional<number | null>;
  declare avatar: CreationOptional<Buffer | null>;
  declare payload: CreationOptional<unknown | null>;
  declare labels: string[];
  declare ttl: CreationOptional<string | null>;
  declare ip: CreationOptional<string | null>;
  declare homepage_url: CreationOptional<string | null>;
  declare born: CreationOptional<string | null>;
  declare alarm: CreationOptional<string | null>;
  declare status: CreationOptional<'draft' | 'live'>;
  declare note: CreationOptional<string>;

  declare sessions?: NonAttribute<Session[]>;
  declare profile?: NonAttribute<Profile>;

  static initModel(sequelize: Sequelize): typeof Account {
    Account.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
        deleted_at: DataTypes.DATE,
        email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        balance: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
        score: DataTypes.DOUBLE,
        avatar: DataTypes.BLOB,
        payload: DataTypes.JSON,
        labels: { type: DataTypes.JSON, allowNull: false },
        ttl: DataTypes.BIGINT,
        ip: DataTypes.STRING(45),
        homepage_url: DataTypes.TEXT,
        born: DataTypes.DATEONLY,
        alarm: DataTypes.TIME,
        status: {
          type: DataTypes.ENUM('draft', 'live'),
          allowNull: false,
          defaultValue: 'draft',
        },
        note: {
          type: DataTypes.TEXT,
          allowNull: false,
          defaultValue: "it's; fine",
        },
      },
      {
        sequelize,
        modelName: 'Account',
        tableName: 'accounts',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
          { fields: ['deleted_at'] },
          { fields: ['email', 'status'] },
        ],
      }
    );
    return Account;
  }
}
