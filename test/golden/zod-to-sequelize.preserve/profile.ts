import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare id: number;
  declare bio: CreationOptional<string | null>;
  declare avatar: CreationOptional<string | null>;
  declare user_id: number;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        bio: DataTypes.TEXT,
        avatar: DataTypes.STRING(100),
        user_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'Profile',
        timestamps: false,
      }
    );
    return Profile;
  }
}
