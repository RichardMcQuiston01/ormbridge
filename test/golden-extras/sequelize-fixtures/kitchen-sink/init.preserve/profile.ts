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
  declare id: CreationOptional<number>;
  declare bio: CreationOptional<string | null>;
  declare owner_account_id: string;

  declare owner?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        bio: DataTypes.TEXT,
        owner_account_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          unique: true,
        },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'profiles',
        timestamps: false,
      }
    );
    return Profile;
  }
}
