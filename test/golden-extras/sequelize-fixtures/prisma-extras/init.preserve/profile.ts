import {
  DataTypes,
  Model,
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
  declare accountId: number;

  declare account?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        region: { type: DataTypes.STRING, primaryKey: true },
        number: { type: DataTypes.INTEGER, primaryKey: true },
        accountId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'Profile',
        schema: 'public',
        timestamps: false,
      }
    );
    return Profile;
  }
}
