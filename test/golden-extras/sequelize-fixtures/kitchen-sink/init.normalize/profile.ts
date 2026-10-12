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
  declare id: CreationOptional<string>;
  declare bio: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare ownerAccountId: string;

  declare owner?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        bio: DataTypes.TEXT,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        ownerAccountId: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
        },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'profile',
        timestamps: true,
        underscored: true,
      }
    );
    return Profile;
  }
}
