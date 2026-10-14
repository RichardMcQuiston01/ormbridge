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

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare region: string;
  declare number: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare accountId: string;

  declare account?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        region: { type: DataTypes.STRING, primaryKey: true },
        number: { type: DataTypes.INTEGER, primaryKey: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        accountId: { type: DataTypes.UUID, allowNull: false, unique: true },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'profile',
        schema: 'public',
        timestamps: true,
        underscored: true,
      }
    );
    return Profile;
  }
}
