import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { User } from './user.js';

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare id: CreationOptional<string>;
  declare bio: CreationOptional<string | null>;
  declare avatar: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare userId: string;

  declare user?: NonAttribute<User>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        bio: DataTypes.TEXT,
        avatar: DataTypes.STRING(100),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false, unique: true },
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
