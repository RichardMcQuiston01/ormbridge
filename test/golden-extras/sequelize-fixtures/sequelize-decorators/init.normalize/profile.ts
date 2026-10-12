import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Author } from './author.js';

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare authorId: string;

  declare author?: NonAttribute<Author>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        authorId: { type: DataTypes.UUID, allowNull: false, unique: true },
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
