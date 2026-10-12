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
  declare id: CreationOptional<number>;
  declare authorId: number;

  declare author?: NonAttribute<Author>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        authorId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
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
